// Dashboard Worker: Google sign-in, the admin API, and WebSocket entry points for runners and browsers.

import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createMiddleware } from 'hono/factory'
import { configAdmins, allowedDomains, domainAllowed, loginDomainAllowed, roleOf, isRole, atLeast, readSession, startLogin, finishLogin, startSession, endSession, providerLabel, LoginError, type AppEnv, type Identity, type Role } from './auth'
import { configuredProviders, parseRoleMapping, mappedRole } from './providers'
import { randomToken, sha256Hex } from './crypto'
import { listNumbers, getNumber, saveNumber, audit } from './db'
import { HUB_NAME } from './hub'
import { parseNumber, parseEmail, parseName, ValidationError } from './validate'
import { listChats, getChat, listMessages, exportStream, purgeOldMessages, type ExportFormat } from './conversations'
import { handleMcp } from './mcp'

export { Hub } from './hub'

type App = AppEnv
const app = new Hono<App>()

const hub = (env: Env) => env.HUB.getByName(HUB_NAME)
const ACTIONS = ['restart', 'unlink', 'pairingCode', 'groups'] as const

// Strict CSP for the app; everything it loads is same-origin
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
}

app.use('*', async (c, next) => {
  await next()
  if (c.res.status === 101) return // WebSocket upgrade responses can't be modified
  // Copy first: responses from the assets binding have immutable headers
  c.res = new Response(c.res.body, c.res)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v)
})

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message, errors: err.errors }, 400)
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  console.error(JSON.stringify({ message: 'request failed', path: c.req.path, error: err instanceof Error ? err.message : String(err) }))
  return c.json({ error: 'Internal error' }, 500)
})

// ---------- Sign-in ----------

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/style.css"></head><body class="center"><main class="card narrow">${body}</main></body></html>`

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

// The login page lists the providers configured in wrangler.jsonc
app.get('/login', c => {
  const providers = configuredProviders(c.env)
  const buttons = providers.map((p, i) => `<a class="button ${i === 0 ? 'primary ' : ''}block" href="/auth/login/${p.id}">Sign in with ${escapeHtml(p.label)}</a>`).join('')
  return c.html(page('Sign in · WhatsApp Bridge', `<h1>WhatsApp Bridge</h1>
    <p class="muted">Manage the WhatsApp numbers connected to your Archestra agents.</p>
    ${buttons || '<p class="error">No sign-in method is set up. Set GOOGLE_CLIENT_ID or ZITADEL_ISSUER and ZITADEL_CLIENT_ID in wrangler.jsonc.</p>'}`))
})

// /auth/login picks the only provider, or shows the choice
app.get('/auth/login', c => {
  const providers = configuredProviders(c.env)
  return providers.length === 1 ? startLogin(c, providers[0].id) : c.redirect('/login')
})

app.get('/auth/login/:provider', async c => {
  const provider = configuredProviders(c.env).find(p => p.id === c.req.param('provider'))
  if (!provider) return c.html(page('Sign-in failed', `<h1>Sign-in failed</h1><p>That sign-in method is not enabled.</p><p><a class="button" href="/login">Back</a></p>`), 404)
  try {
    return await startLogin(c, provider.id)
  } catch (e) {
    const message = e instanceof LoginError ? e.message : `${provider.label} sign-in is not available right now.`
    console.error(JSON.stringify({ message: 'login start failed', provider: provider.id, error: String(e) }))
    return c.html(page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a class="button" href="/login">Back</a></p>`), 502)
  }
})

app.get('/auth/callback', async c => {
  let identity: Identity
  try {
    identity = await finishLogin(c)
  } catch (e) {
    const message = e instanceof LoginError ? e.message : 'Sign-in could not be verified.'
    if (!(e instanceof LoginError)) console.error(JSON.stringify({ message: 'login verification failed', error: String(e) }))
    return c.html(page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a class="button" href="/login">Try again</a></p>`), 400)
  }
  const { email, provider } = identity
  const label = providerLabel(c.env, provider)
  const another = `<p><a class="button" href="/login">Use another account</a></p>`
  const isConfigAdmin = configAdmins(c.env).includes(email)

  // Google: a Workspace domain must match the hd claim. Zitadel is your own identity provider,
  // so its verified email is checked against ALLOWED_DOMAINS directly.
  const domainOk = provider === 'google' ? loginDomainAllowed(c.env, email, identity.hd) : domainAllowed(c.env, email)
  if (!isConfigAdmin && !domainOk) {
    await audit(c.env.DB, email, 'login.denied', null, { reason: 'domain', provider })
    const domains = allowedDomains(c.env).map(d => `@${d}`).join(', ')
    return c.html(page('No access', `<h1>No access</h1><p>Only ${escapeHtml(domains)} accounts can sign in to this dashboard.
      <strong>${escapeHtml(email)}</strong> (${escapeHtml(label)}) is not one of them.</p>${another}`), 403)
  }

  // Zitadel project roles decide the dashboard role when ZITADEL_ROLE_MAPPING is set
  let mapping: ReturnType<typeof parseRoleMapping> = null
  try { mapping = provider === 'zitadel' ? parseRoleMapping(c.env.ZITADEL_ROLE_MAPPING) : null } catch (e) {
    console.error(JSON.stringify({ message: 'bad ZITADEL_ROLE_MAPPING', error: String(e) }))
    return c.html(page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(String((e as Error).message))}</p>`), 500)
  }
  if (!isConfigAdmin && mapping) {
    const now = Date.now()
    const role = mappedRole(mapping, identity.roles)
    await c.env.DB.prepare(`INSERT INTO users (email, role, invited_by, created_at, updated_by, updated_at, last_login_at) VALUES (?, ?, 'zitadel', ?, 'zitadel', ?, ?)
      ON CONFLICT (email) DO UPDATE SET role = excluded.role, updated_by = 'zitadel', updated_at = excluded.updated_at, last_login_at = excluded.last_login_at`)
      .bind(email, role, now, now, now).run()
    if (!role) {
      await audit(c.env.DB, email, 'login.denied', null, { reason: 'no zitadel role', provider, roles: identity.roles })
      return c.html(page('No access', `<h1>No access</h1><p>You are signed in as <strong>${escapeHtml(email)}</strong>,
        but your ${escapeHtml(label)} account has none of the roles that give access to this dashboard. Ask an admin to grant you one in Zitadel, then sign in again.</p>${another}`), 403)
    }
  } else if (!isConfigAdmin) {
    const now = Date.now()
    // With ALLOWED_DOMAINS set, anyone from those domains is recorded so an admin can give them a role.
    // Without it, only users an admin has invited are recorded.
    const known = allowedDomains(c.env).length
      ? await c.env.DB.prepare(`INSERT INTO users (email, role, created_at, last_login_at) VALUES (?, NULL, ?, ?)
          ON CONFLICT (email) DO UPDATE SET last_login_at = excluded.last_login_at`).bind(email, now, now).run()
      : await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE email = ?').bind(now, email).run()
    if (!known.meta.changes) {
      await audit(c.env.DB, email, 'login.denied', null, { reason: 'not invited' })
      return c.html(page('No access', `<h1>No access</h1><p><strong>${escapeHtml(email)}</strong> has not been invited to this dashboard.
        Ask an admin to add you.</p>${another}`), 403)
    }
  }

  const role = await roleOf(c.env, email)
  if (!role) {
    await audit(c.env.DB, email, 'login.pending', null)
    return c.html(page('Waiting for access', `<h1>Waiting for access</h1><p>You are signed in as <strong>${escapeHtml(email)}</strong>,
      but you don't have a role yet. Ask a dashboard admin to give you one on the <em>Users</em> page, then sign in again.</p>${another}`), 403)
  }
  await startSession(c, email)
  await audit(c.env.DB, email, 'login', null, { role, provider })
  return c.redirect('/')
})

app.post('/auth/logout', c => {
  endSession(c)
  return c.redirect('/login')
})

// ---------- Runner connection ----------

app.get('/runner/connect', async c => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket upgrade', 426)
  const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return c.text('Missing runner token', 401)
  const runner = await c.env.DB.prepare('SELECT id FROM runners WHERE token_hash = ?').bind(await sha256Hex(token)).first<{ id: string }>()
  if (!runner) return c.text('Unknown runner token', 401)
  return forwardToHub(c.req.raw, c.env, { 'X-Hub-Kind': 'runner', 'X-Hub-Runner': runner.id })
})

// Only the Worker talks to the hub, and it sets the identity headers itself
function forwardToHub(req: Request, env: Env, identity: Record<string, string>): Promise<Response> {
  const headers = new Headers({ Upgrade: 'websocket' })
  for (const [k, v] of Object.entries(identity)) headers.set(k, v)
  return hub(env).fetch(new Request(req.url, { headers }))
}

// ---------- MCP endpoint for Archestra (authenticated with an MCP key, not a session) ----------

app.all('/mcp', c => handleMcp(c.req.raw, c.env))

// ---------- API (signed-in users with a role) ----------

async function requireUser(c: Context<App>, next: Next) {
  const session = await readSession(c)
  // Re-checked on every request, so a role change or removal takes effect immediately
  const role = session && await roleOf(c.env, session.email)
  if (!session || !role) return c.json({ error: 'Not signed in' }, 401)
  // Same-origin check for anything that changes state, and for WebSockets (which skip CORS)
  const changes = c.req.method !== 'GET' || c.req.header('Upgrade') === 'websocket'
  if (changes && c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({ error: 'Cross-origin request refused' }, 403)
  c.set('session', session)
  c.set('role', role)
  await next()
}

app.use('/api/*', requireUser)

// Route guard: the signed-in user's role must be at least `min`
const need = (min: Role) => createMiddleware<App>(async (c, next) => {
  if (!atLeast(c.get('role'), min)) return c.json({ error: `This needs the ${min} role (you are ${c.get('role')})` }, 403)
  await next()
})

const who = (c: Context<App>) => c.get('session').email

app.get('/api/me', c => c.json({ email: who(c), role: c.get('role') }))

app.get('/api/live', c => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket upgrade', 426)
  const { email, exp } = c.get('session')
  return forwardToHub(c.req.raw, c.env, { 'X-Hub-Kind': 'browser', 'X-Hub-Email': email, 'X-Hub-Exp': String(exp), 'X-Hub-Role': c.get('role') })
})

// --- Users and roles (admins only) ---

type UserRow = { email: string, role: string | null, invited_by: string | null, created_at: number, updated_by: string | null, updated_at: number | null, last_login_at: number | null }

app.get('/api/users', need('admin'), async c => {
  const fromConfig = configAdmins(c.env)
  const { results } = await c.env.DB.prepare('SELECT * FROM users ORDER BY email').all<UserRow>()
  return c.json({
    allowedDomains: allowedDomains(c.env),
    users: [
      ...fromConfig.map(email => ({ email, role: 'admin', source: 'config', status: 'active', invitedBy: null, createdAt: null, updatedBy: null, updatedAt: null, lastLoginAt: null })),
      ...results.filter(u => !fromConfig.includes(u.email)).map(u => ({
        email: u.email,
        role: isRole(u.role) ? u.role : null,
        source: 'dashboard',
        // pending: signed in, waiting for a role; invited: has a role, hasn't signed in yet;
        // blocked: their domain is no longer in ALLOWED_DOMAINS
        status: !domainAllowed(c.env, u.email) ? 'blocked' : !u.role ? 'pending' : u.last_login_at ? 'active' : 'invited',
        invitedBy: u.invited_by,
        createdAt: u.created_at,
        updatedBy: u.updated_by,
        updatedAt: u.updated_at,
        lastLoginAt: u.last_login_at,
      })),
    ],
  })
})

function parseRole(v: unknown, { allowNone = false } = {}): Role | null {
  if (allowNone && v === null) return null
  if (!isRole(v)) throw new ValidationError([`role must be one of viewer, operator, admin${allowNone ? ' or null' : ''}`])
  return v
}

// Invite: give an email a role before they sign in. Also works for someone already waiting (pending).
app.post('/api/users', need('admin'), async c => {
  const body = await c.req.json<{ email?: unknown, role?: unknown }>()
  const email = parseEmail(body.email)
  const role = parseRole(body.role)
  if (configAdmins(c.env).includes(email)) return c.json({ error: `${email} is already an admin (from ADMIN_EMAILS)` }, 409)
  if (!domainAllowed(c.env, email)) return c.json({ error: `Only ${allowedDomains(c.env).map(d => `@${d}`).join(', ')} emails can be invited` }, 400)
  const now = Date.now()
  const res = await c.env.DB.prepare(`INSERT INTO users (email, role, invited_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT (email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    WHERE users.role IS NULL`).bind(email, role, who(c), now, who(c), now).run()
  if (!res.meta.changes) return c.json({ error: `${email} already has a role; change it from the list` }, 409)
  await audit(c.env.DB, who(c), 'user.invite', email, { role })
  return c.json({ email, role }, 201)
})

// Guards shared by role changes and removal
function checkTarget(c: Context<App>, email: string): Response | null {
  if (configAdmins(c.env).includes(email)) return c.json({ error: `${email} comes from ADMIN_EMAILS in wrangler.jsonc; change it there and redeploy` }, 400)
  if (email === who(c)) return c.json({ error: "You can't change your own access. Ask another admin." }, 400)
  return null
}

app.patch('/api/users/:email', need('admin'), async c => {
  const email = c.req.param('email').toLowerCase()
  const blocked = checkTarget(c, email)
  if (blocked) return blocked
  // null takes access away but keeps the user listed (back to pending)
  const role = parseRole((await c.req.json<{ role?: unknown }>()).role, { allowNone: true })
  const before = await c.env.DB.prepare('SELECT role FROM users WHERE email = ?').bind(email).first<{ role: string | null }>()
  if (!before) return c.json({ error: 'No such user' }, 404)
  await c.env.DB.prepare('UPDATE users SET role = ?, updated_by = ?, updated_at = ? WHERE email = ?').bind(role, who(c), Date.now(), email).run()
  // Open tabs reconnect with the new role, or are signed out when access was removed
  await hub(c.env).disconnectBrowser(email, role ? 'role changed' : 'access removed')
  await audit(c.env.DB, who(c), 'user.role', email, { from: before.role, to: role })
  return c.json({ email, role })
})

app.delete('/api/users/:email', need('admin'), async c => {
  const email = c.req.param('email').toLowerCase()
  const blocked = checkTarget(c, email)
  if (blocked) return blocked
  const res = await c.env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run()
  if (!res.meta.changes) return c.json({ error: 'No such user' }, 404)
  await hub(c.env).disconnectBrowser(email, 'access removed')
  await audit(c.env.DB, who(c), 'user.remove', email)
  return c.body(null, 204)
})

// --- Runners ---

// Runner tokens are shown once; only their hash is stored
async function newRunnerToken() {
  const token = `wr_${randomToken(32)}`
  return { token, hash: await sha256Hex(token) }
}

app.get('/api/runners', need('viewer'), async c => {
  const [{ results }, online] = await Promise.all([
    c.env.DB.prepare(`SELECT r.id, r.name, r.created_at, r.last_seen_at, COUNT(n.id) AS numbers
      FROM runners r LEFT JOIN numbers n ON n.runner_id = r.id GROUP BY r.id ORDER BY r.name`).all<{ id: string, name: string, created_at: number, last_seen_at: number | null, numbers: number }>(),
    hub(c.env).listOnlineRunners(),
  ])
  return c.json(results.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, numbers: r.numbers, online: online.includes(r.id) })))
})

app.post('/api/runners', need('admin'), async c => {
  const name = parseName((await c.req.json<{ name?: unknown }>()).name, 'Runner name')
  const id = crypto.randomUUID()
  const { token, hash } = await newRunnerToken()
  await c.env.DB.prepare('INSERT INTO runners (id, name, token_hash, created_at) VALUES (?,?,?,?)').bind(id, name, hash, Date.now()).run()
  await audit(c.env.DB, who(c), 'runner.add', id, { name })
  return c.json({ id, name, token }, 201)
})

app.patch('/api/runners/:id', need('admin'), async c => {
  const name = parseName((await c.req.json<{ name?: unknown }>()).name, 'Runner name')
  const res = await c.env.DB.prepare('UPDATE runners SET name = ? WHERE id = ?').bind(name, c.req.param('id')).run()
  if (!res.meta.changes) return c.json({ error: 'No such runner' }, 404)
  await audit(c.env.DB, who(c), 'runner.rename', c.req.param('id'), { name })
  return c.json({ id: c.req.param('id'), name })
})

app.post('/api/runners/:id/rotate', need('admin'), async c => {
  const id = c.req.param('id')
  const { token, hash } = await newRunnerToken()
  const res = await c.env.DB.prepare('UPDATE runners SET token_hash = ? WHERE id = ?').bind(hash, id).run()
  if (!res.meta.changes) return c.json({ error: 'No such runner' }, 404)
  await hub(c.env).disconnectRunner(id)
  await audit(c.env.DB, who(c), 'runner.rotate', id)
  return c.json({ id, token })
})

app.delete('/api/runners/:id', need('admin'), async c => {
  const id = c.req.param('id')
  const assigned = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM numbers WHERE runner_id = ?').bind(id).first<{ n: number }>()
  if (assigned?.n) return c.json({ error: `This runner still has ${assigned.n} number(s). Move or delete them first.` }, 409)
  const res = await c.env.DB.prepare('DELETE FROM runners WHERE id = ?').bind(id).run()
  if (!res.meta.changes) return c.json({ error: 'No such runner' }, 404)
  await hub(c.env).disconnectRunner(id)
  await audit(c.env.DB, who(c), 'runner.remove', id)
  return c.body(null, 204)
})

// --- Numbers ---

async function checkRunner(env: Env, runnerId: string | null) {
  if (!runnerId) return
  const exists = await env.DB.prepare('SELECT 1 FROM runners WHERE id = ?').bind(runnerId).first()
  if (!exists) throw new ValidationError(['runnerId does not match any runner'])
}

app.get('/api/numbers', need('viewer'), async c => c.json(await listNumbers(c.env.DB)))

app.get('/api/numbers/:id', need('viewer'), async c => {
  const n = await getNumber(c.env.DB, c.req.param('id'))
  return n ? c.json(n) : c.json({ error: 'No such number' }, 404)
})

app.post('/api/numbers', need('operator'), async c => {
  const input = parseNumber(await c.req.json())
  await checkRunner(c.env, input.runnerId)
  const id = crypto.randomUUID()
  await saveNumber(c.env.DB, id, input, { create: true })
  if (input.runnerId) await hub(c.env).syncRunner(input.runnerId)
  await audit(c.env.DB, who(c), 'number.add', id, { name: input.name })
  return c.json(await getNumber(c.env.DB, id), 201)
})

app.put('/api/numbers/:id', need('operator'), async c => {
  const id = c.req.param('id')
  const before = await getNumber(c.env.DB, id)
  if (!before) return c.json({ error: 'No such number' }, 404)
  const input = parseNumber(await c.req.json())
  await checkRunner(c.env, input.runnerId)
  await saveNumber(c.env.DB, id, input, { create: false })
  const h = hub(c.env)
  if (before.runnerId && before.runnerId !== input.runnerId) {
    // Moved: the old runner stops it (its session stays on the old host), the new one starts fresh
    await h.syncRunner(before.runnerId)
    await h.forgetNumber(id)
  }
  if (input.runnerId) await h.syncRunner(input.runnerId)
  await audit(c.env.DB, who(c), 'number.update', id, { name: input.name, ...(before.runnerId !== input.runnerId && { runner: [before.runnerId, input.runnerId] }) })
  return c.json(await getNumber(c.env.DB, id))
})

app.delete('/api/numbers/:id', need('operator'), async c => {
  const id = c.req.param('id')
  const n = await getNumber(c.env.DB, id)
  if (!n) return c.json({ error: 'No such number' }, 404)
  const h = hub(c.env)
  let unlinked = false
  if (n.runnerId) {
    // Log the device out of WhatsApp before forgetting it, so no orphaned session keeps running
    unlinked = (await h.request(n.runnerId, id, 'unlinkAndStop')).ok
  }
  await c.env.DB.prepare('DELETE FROM numbers WHERE id = ?').bind(id).run()
  if (n.runnerId) await h.syncRunner(n.runnerId)
  await h.forgetNumber(id)
  await audit(c.env.DB, who(c), 'number.remove', id, { name: n.name, unlinked })
  return c.json({ unlinked })
})

app.post('/api/numbers/:id/actions/:action', need('operator'), async c => {
  const id = c.req.param('id')
  const action = c.req.param('action') as (typeof ACTIONS)[number]
  if (!ACTIONS.includes(action)) return c.json({ error: `Unknown action. Use one of ${ACTIONS.join(', ')}` }, 404)
  const n = await getNumber(c.env.DB, id)
  if (!n) return c.json({ error: 'No such number' }, 404)
  if (!n.runnerId) return c.json({ error: 'Assign this number to a runner first' }, 409)
  const args: Record<string, string> = action === 'pairingCode' ? { phone: String((await c.req.json<{ phone?: unknown }>()).phone ?? '') } : {}
  const outcome = await hub(c.env).request(n.runnerId, id, action, args)
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.offline ? 409 : 502)
  const result: unknown = JSON.parse(outcome.result)
  // Reading the group list changes nothing, so it isn't audited
  if (action !== 'groups') await audit(c.env.DB, who(c), `number.${action}`, id, action === 'pairingCode' ? { phone: args.phone } : undefined)
  return c.json({ result })
})

// --- Conversations (operators: they hold customer messages) ---

async function numberOr404(c: Context<App>) {
  const n = await getNumber(c.env.DB, c.req.param('id')!)
  if (!n) throw new HTTPException(404, { message: 'No such number' })
  return n
}

// Accepts epoch milliseconds or anything Date.parse understands (e.g. 2026-11-02)
function parseTime(v: string | undefined, what: string): number | undefined {
  if (!v) return undefined
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  if (!Number.isFinite(t)) throw new ValidationError([`${what} must be a date or epoch milliseconds`])
  return t
}

app.get('/api/numbers/:id/chats', need('operator'), async c => {
  const n = await numberOr404(c)
  return c.json(await listChats(c.env.DB, n.id, {
    q: c.req.query('q')?.slice(0, 100) || undefined,
    before: parseTime(c.req.query('before'), 'before'),
    limit: Number(c.req.query('limit')) || 50,
  }))
})

app.get('/api/numbers/:id/chats/:jid', need('operator'), async c => {
  const n = await numberOr404(c)
  const jid = c.req.param('jid')
  const chat = await getChat(c.env.DB, n.id, jid)
  if (!chat) return c.json({ error: 'No such chat' }, 404)
  const [messages, handoffs] = await Promise.all([
    listMessages(c.env.DB, n.id, jid, { before: parseTime(c.req.query('before'), 'before'), limit: Number(c.req.query('limit')) || 200 }),
    c.env.DB.prepare('SELECT * FROM handoffs WHERE number_id = ? AND jid = ? ORDER BY at DESC LIMIT 20').bind(n.id, jid).all<HandoffRow>(),
  ])
  return c.json({ chat, messages, handoffs: handoffs.results.map(toHandoff) })
})

type HandoffRow = { id: string, number_id: string, jid: string, at: number, reason: string, summary: string | null, topic: string | null, urgency: string,
  status: string, notified: string, requested_by: string | null, resolved_by: string | null, resolved_at: number | null, chat_name?: string | null }
const toHandoff = (h: HandoffRow) => ({
  id: h.id, jid: h.jid, at: h.at, reason: h.reason, summary: h.summary, topic: h.topic, urgency: h.urgency, status: h.status,
  notified: JSON.parse(h.notified), requestedBy: h.requested_by, resolvedBy: h.resolved_by, resolvedAt: h.resolved_at,
  ...(h.chat_name !== undefined && { chatName: h.chat_name }),
})

app.get('/api/numbers/:id/handoffs', need('operator'), async c => {
  const n = await numberOr404(c)
  const status = c.req.query('status')
  const { results } = await c.env.DB.prepare(`SELECT h.*, c.name AS chat_name FROM handoffs h
    LEFT JOIN chats c ON c.number_id = h.number_id AND c.jid = h.jid
    WHERE h.number_id = ? ${status ? 'AND h.status = ?' : ''} ORDER BY h.at DESC LIMIT 100`).bind(...(status ? [n.id, status] : [n.id])).all<HandoffRow>()
  return c.json(results.map(toHandoff))
})

// Pause the bot in a chat (a person takes over) or resume it. Resuming also closes open handoffs.
app.post('/api/numbers/:id/chats/:jid/:action{pause|resume}', need('operator'), async c => {
  const n = await numberOr404(c)
  const jid = c.req.param('jid')
  const action = c.req.param('action') as 'pause' | 'resume'
  if (!await getChat(c.env.DB, n.id, jid)) return c.json({ error: 'No such chat' }, 404)
  if (!n.runnerId) return c.json({ error: 'Assign this number to a runner first' }, 409)
  const minutes = action === 'pause' ? Number((await c.req.json<{ minutes?: unknown }>().catch(() => ({} as { minutes?: unknown }))).minutes ?? 60) : 0
  if (action === 'pause' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60)) throw new ValidationError(['minutes must be a whole number from 1 to 10080'])
  const outcome = await hub(c.env).request(n.runnerId, n.id, action, { jid, minutes })
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.offline ? 409 : 502)
  const { pausedUntil = null } = JSON.parse(outcome.result) as { pausedUntil?: number | null }
  const now = Date.now()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE chats SET paused_until = ? WHERE number_id = ? AND jid = ?').bind(pausedUntil, n.id, jid),
    ...(action === 'resume' ? [c.env.DB.prepare(`UPDATE handoffs SET status = 'resolved', resolved_by = ?, resolved_at = ?
      WHERE number_id = ? AND jid = ? AND status = 'open'`).bind(who(c), now, n.id, jid)] : []),
  ])
  await audit(c.env.DB, who(c), `chat.${action}`, n.id, { chat: jid, ...(action === 'pause' && { minutes }) })
  return c.json({ pausedUntil })
})

app.post('/api/numbers/:id/handoffs/:handoffId/resolve', need('operator'), async c => {
  const n = await numberOr404(c)
  const res = await c.env.DB.prepare(`UPDATE handoffs SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND number_id = ? AND status != 'resolved'`)
    .bind(who(c), Date.now(), c.req.param('handoffId'), n.id).run()
  if (!res.meta.changes) return c.json({ error: 'No such open handoff' }, 404)
  await audit(c.env.DB, who(c), 'handoff.resolve', n.id, { handoff: c.req.param('handoffId') })
  return c.json({ ok: true })
})

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat'

// Download recorded messages as JSON Lines or CSV, for one chat or the whole number
app.get('/api/numbers/:id/export', need('operator'), async c => {
  const n = await numberOr404(c)
  const format = (c.req.query('format') || 'jsonl') as ExportFormat
  if (format !== 'jsonl' && format !== 'csv') throw new ValidationError(['format must be jsonl or csv'])
  const jid = c.req.query('jid') || undefined
  const from = parseTime(c.req.query('from'), 'from')
  const to = parseTime(c.req.query('to'), 'to')
  await audit(c.env.DB, who(c), 'conversations.export', n.id, { format, ...(jid && { chat: jid }), ...(from && { from }), ...(to && { to }) })
  const name = `whatsapp-${slug(n.name)}${jid ? `-${slug(jid.split('@')[0])}` : ''}-${new Date().toISOString().slice(0, 10)}.${format}`
  return new Response(exportStream(c.env.DB, n.id, n.name, format, { jid, from, to }), {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
})

// --- MCP keys (admins): what Archestra uses to call /mcp ---

app.get('/api/mcp-keys', need('admin'), async c => {
  const { results } = await c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM mcp_keys ORDER BY name').all<{ id: string, name: string, created_at: number, last_used_at: number | null }>()
  return c.json(results.map(k => ({ id: k.id, name: k.name, createdAt: k.created_at, lastUsedAt: k.last_used_at })))
})

app.post('/api/mcp-keys', need('admin'), async c => {
  const name = parseName((await c.req.json<{ name?: unknown }>()).name, 'Key name')
  const id = crypto.randomUUID()
  const token = `mk_${randomToken(32)}`
  await c.env.DB.prepare('INSERT INTO mcp_keys (id, name, token_hash, created_at) VALUES (?,?,?,?)').bind(id, name, await sha256Hex(token), Date.now()).run()
  await audit(c.env.DB, who(c), 'mcp_key.add', id, { name })
  return c.json({ id, name, token, url: `${new URL(c.req.url).origin}/mcp` }, 201)
})

app.delete('/api/mcp-keys/:id', need('admin'), async c => {
  const res = await c.env.DB.prepare('DELETE FROM mcp_keys WHERE id = ?').bind(c.req.param('id')).run()
  if (!res.meta.changes) return c.json({ error: 'No such key' }, 404)
  await audit(c.env.DB, who(c), 'mcp_key.remove', c.req.param('id'))
  return c.body(null, 204)
})

// --- Audit log ---

app.get('/api/audit', need('operator'), async c => {
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500)
  const { results } = await c.env.DB.prepare('SELECT at, email, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?').bind(limit).all()
  return c.json(results.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail as string) : null })))
})

app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

// ---------- Static app ----------

// Reachable without signing in (the assets binding serves /login.html at /login)
const PUBLIC_ASSETS = new Set(['/style.css', '/favicon.svg'])

app.get('*', async c => {
  const path = new URL(c.req.url).pathname
  if (!PUBLIC_ASSETS.has(path)) {
    const session = await readSession(c)
    if (!session || !await roleOf(c.env, session.email)) return c.redirect('/login')
  }
  return c.env.ASSETS.fetch(c.req.raw)
})

export default {
  fetch: app.fetch,
  // Daily: delete recorded messages older than MESSAGE_RETENTION_DAYS (0 or empty keeps them)
  async scheduled(_controller, env) {
    const days = Number(env.MESSAGE_RETENTION_DAYS)
    if (!Number.isFinite(days) || days <= 0) return
    const deleted = await purgeOldMessages(env.DB, days)
    console.log(JSON.stringify({ message: 'retention', days, deleted }))
  },
} satisfies ExportedHandler<Env>
