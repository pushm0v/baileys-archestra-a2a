// Dashboard Worker: Google sign-in, the admin API, and WebSocket entry points for runners and browsers.

import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { configAdmins, isAdmin, readSession, startLogin, finishLogin, startSession, endSession, LoginError, type AppEnv } from './auth'
import { randomToken, sha256Hex } from './crypto'
import { listNumbers, getNumber, saveNumber, audit } from './db'
import { HUB_NAME } from './hub'
import { parseNumber, parseEmail, parseName, ValidationError } from './validate'

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

app.get('/auth/login', c => startLogin(c))

app.get('/auth/callback', async c => {
  let email: string
  try {
    email = await finishLogin(c)
  } catch (e) {
    const message = e instanceof LoginError ? e.message : 'Google sign-in could not be verified.'
    if (!(e instanceof LoginError)) console.error(JSON.stringify({ message: 'login verification failed', error: String(e) }))
    return c.html(page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a class="button" href="/auth/login">Try again</a></p>`), 400)
  }
  if (!await isAdmin(c.env, email)) {
    await audit(c.env.DB, email, 'login.denied', null)
    return c.html(page('No access', `<h1>No access</h1><p><strong>${escapeHtml(email)}</strong> is not an admin of this dashboard.
      Ask an existing admin to add you.</p><p><a class="button" href="/auth/login">Use another Google account</a></p>`), 403)
  }
  await startSession(c, email)
  await audit(c.env.DB, email, 'login', null)
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

// ---------- API (signed-in admins only) ----------

async function requireAdmin(c: Context<App>, next: Next) {
  const session = await readSession(c)
  // Re-checked on every request, so removing an admin takes effect immediately
  if (!session || !await isAdmin(c.env, session.email)) return c.json({ error: 'Not signed in' }, 401)
  // Same-origin check for anything that changes state, and for WebSockets (which skip CORS)
  const changes = c.req.method !== 'GET' || c.req.header('Upgrade') === 'websocket'
  if (changes && c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({ error: 'Cross-origin request refused' }, 403)
  c.set('session', session)
  await next()
}

app.use('/api/*', requireAdmin)

const who = (c: Context<App>) => c.get('session').email

app.get('/api/me', c => c.json({ email: who(c) }))

app.get('/api/live', c => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket upgrade', 426)
  const { email, exp } = c.get('session')
  return forwardToHub(c.req.raw, c.env, { 'X-Hub-Kind': 'browser', 'X-Hub-Email': email, 'X-Hub-Exp': String(exp) })
})

// --- Admins ---

app.get('/api/users', async c => {
  const fromConfig = configAdmins(c.env)
  const { results } = await c.env.DB.prepare('SELECT email, added_by, created_at FROM users ORDER BY email').all<{ email: string, added_by: string, created_at: number }>()
  return c.json([
    ...fromConfig.map(email => ({ email, source: 'config', addedBy: null, createdAt: null })),
    ...results.filter(u => !fromConfig.includes(u.email)).map(u => ({ email: u.email, source: 'dashboard', addedBy: u.added_by, createdAt: u.created_at })),
  ])
})

app.post('/api/users', async c => {
  const email = parseEmail((await c.req.json<{ email?: unknown }>()).email)
  if (configAdmins(c.env).includes(email)) return c.json({ error: `${email} is already an admin (from ADMIN_EMAILS)` }, 409)
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO users (email, added_by, created_at) VALUES (?,?,?)').bind(email, who(c), Date.now()).run()
  if (!res.meta.changes) return c.json({ error: `${email} is already an admin` }, 409)
  await audit(c.env.DB, who(c), 'admin.add', email)
  return c.json({ email }, 201)
})

app.delete('/api/users/:email', async c => {
  const email = c.req.param('email').toLowerCase()
  if (configAdmins(c.env).includes(email)) return c.json({ error: `${email} comes from ADMIN_EMAILS in wrangler.jsonc; remove it there and redeploy` }, 400)
  const res = await c.env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run()
  if (!res.meta.changes) return c.json({ error: 'No such admin' }, 404)
  await hub(c.env).disconnectBrowser(email)
  await audit(c.env.DB, who(c), 'admin.remove', email)
  return c.body(null, 204)
})

// --- Runners ---

// Runner tokens are shown once; only their hash is stored
async function newRunnerToken() {
  const token = `wr_${randomToken(32)}`
  return { token, hash: await sha256Hex(token) }
}

app.get('/api/runners', async c => {
  const [{ results }, online] = await Promise.all([
    c.env.DB.prepare(`SELECT r.id, r.name, r.created_at, r.last_seen_at, COUNT(n.id) AS numbers
      FROM runners r LEFT JOIN numbers n ON n.runner_id = r.id GROUP BY r.id ORDER BY r.name`).all<{ id: string, name: string, created_at: number, last_seen_at: number | null, numbers: number }>(),
    hub(c.env).listOnlineRunners(),
  ])
  return c.json(results.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, numbers: r.numbers, online: online.includes(r.id) })))
})

app.post('/api/runners', async c => {
  const name = parseName((await c.req.json<{ name?: unknown }>()).name, 'Runner name')
  const id = crypto.randomUUID()
  const { token, hash } = await newRunnerToken()
  await c.env.DB.prepare('INSERT INTO runners (id, name, token_hash, created_at) VALUES (?,?,?,?)').bind(id, name, hash, Date.now()).run()
  await audit(c.env.DB, who(c), 'runner.add', id, { name })
  return c.json({ id, name, token }, 201)
})

app.patch('/api/runners/:id', async c => {
  const name = parseName((await c.req.json<{ name?: unknown }>()).name, 'Runner name')
  const res = await c.env.DB.prepare('UPDATE runners SET name = ? WHERE id = ?').bind(name, c.req.param('id')).run()
  if (!res.meta.changes) return c.json({ error: 'No such runner' }, 404)
  await audit(c.env.DB, who(c), 'runner.rename', c.req.param('id'), { name })
  return c.json({ id: c.req.param('id'), name })
})

app.post('/api/runners/:id/rotate', async c => {
  const id = c.req.param('id')
  const { token, hash } = await newRunnerToken()
  const res = await c.env.DB.prepare('UPDATE runners SET token_hash = ? WHERE id = ?').bind(hash, id).run()
  if (!res.meta.changes) return c.json({ error: 'No such runner' }, 404)
  await hub(c.env).disconnectRunner(id)
  await audit(c.env.DB, who(c), 'runner.rotate', id)
  return c.json({ id, token })
})

app.delete('/api/runners/:id', async c => {
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

app.get('/api/numbers', async c => c.json(await listNumbers(c.env.DB)))

app.get('/api/numbers/:id', async c => {
  const n = await getNumber(c.env.DB, c.req.param('id'))
  return n ? c.json(n) : c.json({ error: 'No such number' }, 404)
})

app.post('/api/numbers', async c => {
  const input = parseNumber(await c.req.json())
  await checkRunner(c.env, input.runnerId)
  const id = crypto.randomUUID()
  await saveNumber(c.env.DB, id, input, { create: true })
  if (input.runnerId) await hub(c.env).syncRunner(input.runnerId)
  await audit(c.env.DB, who(c), 'number.add', id, { name: input.name })
  return c.json(await getNumber(c.env.DB, id), 201)
})

app.put('/api/numbers/:id', async c => {
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

app.delete('/api/numbers/:id', async c => {
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

app.post('/api/numbers/:id/actions/:action', async c => {
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

// --- Audit log ---

app.get('/api/audit', async c => {
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500)
  const { results } = await c.env.DB.prepare('SELECT at, email, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?').bind(limit).all()
  return c.json(results.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail as string) : null })))
})

app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

// ---------- Static app ----------

// Reachable without signing in (the assets binding serves /login.html at /login)
const PUBLIC_ASSETS = new Set(['/login', '/login.html', '/style.css', '/favicon.svg'])

app.get('*', async c => {
  const path = new URL(c.req.url).pathname
  if (!PUBLIC_ASSETS.has(path)) {
    const session = await readSession(c)
    if (!session || !await isAdmin(c.env, session.email)) return c.redirect('/login')
  }
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app satisfies ExportedHandler<Env>
