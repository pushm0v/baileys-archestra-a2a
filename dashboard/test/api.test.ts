import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { exports, env } from 'cloudflare:workers'
import { evictDurableObject } from 'cloudflare:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { sign } from '../src/crypto'

const ORIGIN = 'https://dash.example.com'
const SECRET = 'test-session-secret'
const ADMIN = 'boss@example.com'

const worker = exports.default as unknown as Fetcher

async function sessionCookie(email: string, exp = Date.now() + 60_000) {
  return `__Host-session=${await sign({ email, exp }, SECRET)}`
}

async function call(method: string, path: string, { email = ADMIN as string | null, body, origin = true }: { email?: string | null, body?: unknown, origin?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (email) headers.Cookie = await sessionCookie(email)
  if (origin) headers.Origin = ORIGIN
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return worker.fetch(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
}

// WebSocket client that buffers messages so tests can wait for a specific one
function client(ws: WebSocket) {
  ws.accept()
  const messages: any[] = []
  const waiters: Array<{ match: (m: any) => boolean, resolve: (m: any) => void }> = []
  ws.addEventListener('message', e => {
    const m = typeof e.data === 'string' && e.data.startsWith('{') ? JSON.parse(e.data) : e.data
    messages.push(m)
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
  })
  return {
    ws,
    send: (m: unknown) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: (match: (m: any) => boolean, timeoutMs = 3000) => {
      const found = messages.find(match)
      if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found) }
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
        waiters.push({ match: m => { const ok = match(m); if (ok) { messages.splice(messages.indexOf(m), 1); clearTimeout(timer) } return ok }, resolve })
      })
    },
  }
}

async function connectRunner(token: string) {
  const res = await worker.fetch(`${ORIGIN}/runner/connect`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } })
  expect(res.status).toBe(101)
  return client(res.webSocket!)
}

async function connectBrowser(email = ADMIN) {
  const res = await worker.fetch(`${ORIGIN}/api/live`, { headers: { Upgrade: 'websocket', Cookie: await sessionCookie(email), Origin: ORIGIN } })
  expect(res.status).toBe(101)
  return client(res.webSocket!)
}

afterEach(() => { vi.restoreAllMocks() })

describe('sign-in', () => {
  it('sends signed-out visitors to the login page', async () => {
    const res = await call('GET', '/', { email: null })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login')
    expect((await call('GET', '/api/me', { email: null })).status).toBe(401)
  })

  it('starts Google sign-in with PKCE and a nonce', async () => {
    const res = await call('GET', '/auth/login', { email: null })
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('Location')!)
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(res.headers.get('Set-Cookie')).toMatch(/__Host-oauth=.*HttpOnly.*Secure/i)
  })

  it('rejects a callback whose state does not match', async () => {
    const res = await call('GET', '/auth/callback?code=x&state=forged', { email: null })
    expect(res.status).toBe(400)
  })

  describe('full Google round trip', () => {
    let keys: Awaited<ReturnType<typeof generateKeyPair>>
    let jwk: Record<string, unknown>
    beforeAll(async () => {
      keys = await generateKeyPair('RS256')
      jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
    })

    async function signIn(email: string, { verified = true, nonceOverride, hd = email.toLowerCase().endsWith('@example.com') ? 'example.com' : undefined }: { verified?: boolean, nonceOverride?: string, hd?: string } = {}) {
      const start = await call('GET', '/auth/login', { email: null })
      const google = new URL(start.headers.get('Location')!)
      const oauthCookie = start.headers.get('Set-Cookie')!.split(';')[0]
      const idToken = await new SignJWT({ email, email_verified: verified, nonce: nonceOverride ?? google.searchParams.get('nonce'), ...(hd && { hd }) })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer('https://accounts.google.com')
        .setAudience('test-client.apps.googleusercontent.com')
        .setSubject('123')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey)

      const realFetch = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url === 'https://oauth2.googleapis.com/token') {
          const form = new URLSearchParams(String(init?.body))
          expect(form.get('code_verifier')).toBeTruthy()
          expect(form.get('client_secret')).toBe('test-secret')
          return Response.json({ id_token: idToken })
        }
        if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] })
        return realFetch(input, init)
      })
      return worker.fetch(`${ORIGIN}/auth/callback?code=abc&state=${google.searchParams.get('state')}`, { headers: { Cookie: oauthCookie }, redirect: 'manual' })
    }

    it('signs in a default admin (case-insensitive) and sets a session', async () => {
      const res = await signIn('Second@example.com')
      expect(res.status).toBe(302)
      const cookie = res.headers.get('Set-Cookie')!
      expect(cookie).toMatch(/__Host-session=/)
      const me = await worker.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: cookie.match(/__Host-session=[^;]+/)![0] } })
      expect(await me.json()).toEqual({ email: 'second@example.com', role: 'admin' })
    })

    it('refuses accounts outside ALLOWED_DOMAINS, including personal accounts using a work address', async () => {
      const outside = await signIn('someone@gmail.com')
      expect(outside.status).toBe(403)
      expect(await outside.text()).toContain('Only @example.com')
      expect(outside.headers.get('Set-Cookie') ?? '').not.toMatch(/__Host-session=[^;]/)
      // Right email domain, but not a Workspace account of that domain
      expect((await signIn('sneaky@example.com', { hd: '' })).status).toBe(403)
      expect((await signIn('sneaky@example.com', { hd: 'other.com' })).status).toBe(403)
      const { users } = await (await call('GET', '/api/users')).json<any>()
      expect(users.map((u: any) => u.email)).not.toContain('sneaky@example.com')
    })

    it('records allowed-domain users as waiting, and lets them in once an admin gives them a role', async () => {
      const first = await signIn('Newbie@example.com')
      expect(first.status).toBe(403)
      expect(await first.text()).toContain('Waiting for access')
      expect(first.headers.get('Set-Cookie') ?? '').not.toMatch(/__Host-session=[^;]/)

      const { users } = await (await call('GET', '/api/users')).json<any>()
      expect(users.find((u: any) => u.email === 'newbie@example.com')).toMatchObject({ role: null, status: 'pending' })

      expect((await call('PATCH', '/api/users/newbie@example.com', { body: { role: 'viewer' } })).status).toBe(200)
      const second = await signIn('newbie@example.com')
      expect(second.status).toBe(302)
      const me = await worker.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: second.headers.get('Set-Cookie')!.match(/__Host-session=[^;]+/)![0] } })
      expect(await me.json()).toEqual({ email: 'newbie@example.com', role: 'viewer' })
    })

    it('asks Google for accounts of the one allowed domain', async () => {
      const res = await call('GET', '/auth/login', { email: null })
      expect(new URL(res.headers.get('Location')!).searchParams.get('hd')).toBe('example.com')
    })

    it('refuses unverified emails and replayed tokens', async () => {
      expect((await signIn(ADMIN, { verified: false })).status).toBe(400)
      expect((await signIn(ADMIN, { nonceOverride: 'other' })).status).toBe(400)
    })
  })
})

describe('users and roles', () => {
  it('lists config admins and invites, changes and removes users', async () => {
    const first = await (await call('GET', '/api/users')).json<any>()
    expect(first.allowedDomains).toEqual(['example.com'])
    expect(first.users.filter((u: any) => u.source === 'config').map((u: any) => [u.email, u.role])).toEqual([['boss@example.com', 'admin'], ['second@example.com', 'admin']])

    expect((await call('POST', '/api/users', { body: { email: 'new@example.com', role: 'admin' }, origin: false })).status).toBe(403)
    expect((await call('POST', '/api/users', { body: { email: 'new@example.com' } })).status).toBe(400) // role is required
    expect((await call('POST', '/api/users', { body: { email: 'new@example.com', role: 'owner' } })).status).toBe(400)
    expect((await call('POST', '/api/users', { body: { email: 'friend@gmail.com', role: 'viewer' } })).status).toBe(400) // outside ALLOWED_DOMAINS
    expect((await call('POST', '/api/users', { body: { email: 'New@Example.com', role: 'operator' } })).status).toBe(201)
    expect((await call('POST', '/api/users', { body: { email: 'new@example.com', role: 'viewer' } })).status).toBe(409)
    const { users } = await (await call('GET', '/api/users')).json<any>()
    expect(users.find((u: any) => u.email === 'new@example.com')).toMatchObject({ role: 'operator', status: 'invited', invitedBy: ADMIN })
    expect(await (await call('GET', '/api/me', { email: 'new@example.com' })).json()).toEqual({ email: 'new@example.com', role: 'operator' })

    // Config admins and your own account can't be changed here
    expect((await call('PATCH', '/api/users/boss@example.com', { body: { role: 'viewer' }, email: 'second@example.com' })).status).toBe(400)
    expect((await call('DELETE', '/api/users/boss@example.com', { email: 'second@example.com' })).status).toBe(400)
    await call('POST', '/api/users', { body: { email: 'self@example.com', role: 'admin' } })
    expect((await call('PATCH', '/api/users/self@example.com', { body: { role: 'viewer' }, email: 'self@example.com' })).status).toBe(400)

    // Revoking keeps the user listed but signs them out at once
    expect((await call('PATCH', '/api/users/new@example.com', { body: { role: null } })).status).toBe(200)
    expect((await call('GET', '/api/me', { email: 'new@example.com' })).status).toBe(401)
    expect((await call('POST', '/api/users', { body: { email: 'new@example.com', role: 'viewer' } })).status).toBe(201) // a pending user can be invited again

    expect((await call('DELETE', '/api/users/new@example.com')).status).toBe(204)
    expect((await call('GET', '/api/me', { email: 'new@example.com' })).status).toBe(401)
    expect((await call('PATCH', '/api/users/new@example.com', { body: { role: 'viewer' } })).status).toBe(404)

    const audit = await (await call('GET', '/api/audit')).json<any[]>()
    expect(audit.map(a => a.action)).toEqual(expect.arrayContaining(['user.invite', 'user.role', 'user.remove']))
  })

  it('limits what viewers and operators can do', async () => {
    await call('POST', '/api/users', { body: { email: 'viewer@example.com', role: 'viewer' } })
    await call('POST', '/api/users', { body: { email: 'op@example.com', role: 'operator' } })
    const runner = await (await call('POST', '/api/runners', { body: { name: 'roles' } })).json<{ id: string }>()
    const number = { name: 'Roles', runnerId: runner.id, agentId: 'a' }

    const viewer = { email: 'viewer@example.com' }
    expect((await call('GET', '/api/numbers', viewer)).status).toBe(200)
    expect((await call('GET', '/api/runners', viewer)).status).toBe(200)
    expect((await call('POST', '/api/numbers', { ...viewer, body: number })).status).toBe(403)
    expect((await call('GET', '/api/audit', viewer)).status).toBe(403)
    expect((await call('GET', '/api/users', viewer)).status).toBe(403)

    const op = { email: 'op@example.com' }
    const created = await call('POST', '/api/numbers', { ...op, body: number })
    expect(created.status).toBe(201)
    const { id } = await created.json<{ id: string }>()
    expect((await call('POST', `/api/numbers/${id}/actions/restart`, viewer)).status).toBe(403)
    expect((await call('POST', `/api/numbers/${id}/actions/restart`, op)).status).toBe(409) // allowed; the runner is offline
    expect((await call('GET', '/api/audit', op)).status).toBe(200)
    expect((await call('POST', '/api/runners', { ...op, body: { name: 'nope' } })).status).toBe(403)
    expect((await call('POST', `/api/runners/${runner.id}/rotate`, op)).status).toBe(403)
    expect((await call('GET', '/api/users', op)).status).toBe(403)
    expect((await call('POST', '/api/users', { ...op, body: { email: 'x@example.com', role: 'admin' } })).status).toBe(403)
  })

  it('never sends QR codes to viewers, and reconnects tabs when a role changes', async () => {
    await call('POST', '/api/users', { body: { email: 'watcher@example.com', role: 'viewer' } })
    const runner = await (await call('POST', '/api/runners', { body: { name: 'qr' } })).json<{ id: string, token: string }>()
    const { id } = await (await call('POST', '/api/numbers', { body: { name: 'QR', runnerId: runner.id, agentId: 'a' } })).json<{ id: string }>()
    const rws = await connectRunner(runner.token)
    rws.send({ type: 'hello', statuses: [] })
    await rws.next(m => m.type === 'sync')

    const admin = await connectBrowser()
    await admin.next(m => m.type === 'snapshot')
    const viewer = await connectBrowser('watcher@example.com')
    await viewer.next(m => m.type === 'snapshot')

    rws.send({ type: 'qr', numberId: id, svg: '<svg/>' })
    rws.send({ type: 'status', numberId: id, state: 'waiting_for_scan' })
    await admin.next(m => m.type === 'qr')
    await viewer.next(m => m.type === 'status' && m.numberId === id)
    await expect(viewer.next(m => m.type === 'qr', 300)).rejects.toThrow()

    const late = await connectBrowser('watcher@example.com')
    expect((await late.next(m => m.type === 'snapshot')).qrs).toEqual({})

    const closed = new Promise<CloseEvent>(resolve => late.ws.addEventListener('close', resolve))
    await call('PATCH', '/api/users/watcher@example.com', { body: { role: 'operator' } })
    expect((await closed).code).toBe(4409)
    const promoted = await connectBrowser('watcher@example.com')
    expect((await promoted.next(m => m.type === 'snapshot')).qrs[id]).toBe('<svg/>')
  })

  it('refuses sessions that are expired or signed with another key', async () => {
    const expired = await sessionCookie(ADMIN, Date.now() - 1000)
    expect((await worker.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: expired } })).status).toBe(401)
    const forged = `__Host-session=${await sign({ email: ADMIN, exp: Date.now() + 60_000 }, 'wrong')}`
    expect((await worker.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: forged } })).status).toBe(401)
  })
})

describe('runners and numbers', () => {
  it('rejects unknown runner tokens', async () => {
    const res = await worker.fetch(`${ORIGIN}/runner/connect`, { headers: { Upgrade: 'websocket', Authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  it('syncs settings to the runner, relays status and runs commands', async () => {
    const runner = await (await call('POST', '/api/runners', { body: { name: 'k8s' } })).json<{ id: string, token: string }>()
    expect(runner.token).toMatch(/^wr_/)

    const browser = await connectBrowser()
    await browser.next(m => m.type === 'snapshot')

    const rws = await connectRunner(runner.token)
    await browser.next(m => m.type === 'runner' && m.runnerId === runner.id && m.online)
    rws.send({ type: 'hello', statuses: [] })
    expect((await rws.next(m => m.type === 'sync')).numbers).toEqual([])

    // Creating a number pushes it to its runner, without any token value
    const created = await call('POST', '/api/numbers', { body: {
      name: 'Support', runnerId: runner.id, agentId: 'agent-1', tokenRef: 'SUPPORT_TOKEN',
      routes: [{ key: '120363@g.us', agentId: 'agent-2', trigger: 'all', allowedNumbers: ['628123'] }],
    } })
    expect(created.status).toBe(201)
    const number = await created.json<{ id: string }>()
    const sync = await rws.next(m => m.type === 'sync' && m.numbers.length === 1)
    expect(sync.numbers[0]).toMatchObject({ id: number.id, agentId: 'agent-1', tokenRef: 'SUPPORT_TOKEN', enabled: true,
      routes: { '120363@g.us': { agentId: 'agent-2', trigger: 'all', allowedNumbers: ['628123'] } } })

    // Status and QR codes from the runner reach the browser
    rws.send({ type: 'status', numberId: number.id, state: 'waiting_for_scan' })
    expect(await browser.next(m => m.type === 'status')).toMatchObject({ numberId: number.id, state: 'waiting_for_scan', runnerId: runner.id })
    rws.send({ type: 'qr', numberId: number.id, svg: '<svg/>' })
    expect(await browser.next(m => m.type === 'qr')).toMatchObject({ numberId: number.id, svg: '<svg/>' })

    // A runner can't report on numbers that aren't its own
    rws.send({ type: 'status', numberId: 'someone-else', state: 'connected' })

    // Commands round-trip through the runner
    const pending = call('POST', `/api/numbers/${number.id}/actions/pairingCode`, { body: { phone: '6281234' } })
    const req = await rws.next(m => m.type === 'request')
    expect(req).toMatchObject({ numberId: number.id, action: 'pairingCode', args: { phone: '6281234' } })
    rws.send({ type: 'response', id: req.id, ok: true, result: { code: 'ABCD1234' } })
    expect(await (await pending).json()).toEqual({ result: { code: 'ABCD1234' } })

    const failing = call('POST', `/api/numbers/${number.id}/actions/groups`)
    const req2 = await rws.next(m => m.type === 'request' && m.action === 'groups')
    rws.send({ type: 'response', id: req2.id, ok: false, error: 'WhatsApp is not connected yet' })
    const failed = await failing
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: 'WhatsApp is not connected yet' })

    rws.send({ type: 'log', numberId: number.id, stream: 'stdout', line: 'hello from the bridge', at: Date.now() })
    await browser.next(m => m.type === 'log')

    // QR codes and logs survive the hub being evicted from memory (hibernation)
    await evictDurableObject(env.HUB.getByName('global'))

    // A new browser gets the current state in its snapshot
    const late = await connectBrowser()
    const snap = await late.next(m => m.type === 'snapshot')
    expect(snap.live[number.id].state).toBe('waiting_for_scan')
    expect(snap.live['someone-else']).toBeUndefined()
    expect(snap.qrs[number.id]).toBe('<svg/>')
    expect(snap.logs[number.id].map((l: any) => l.line)).toEqual(['hello from the bridge'])
    expect(snap.onlineRunners).toContain(runner.id)

    // The runner can't be removed while it has numbers
    expect((await call('DELETE', `/api/runners/${runner.id}`)).status).toBe(409)

    // Deleting a number unlinks it on the runner first
    const del = call('DELETE', `/api/numbers/${number.id}`)
    const unlink = await rws.next(m => m.type === 'request' && m.action === 'unlinkAndStop')
    rws.send({ type: 'response', id: unlink.id, ok: true, result: { ok: true } })
    expect(await (await del).json()).toEqual({ unlinked: true })
    expect(await rws.next(m => m.type === 'sync' && m.numbers.length === 0)).toBeTruthy()

    // Rotating the token disconnects the runner
    const closed = new Promise(resolve => rws.ws.addEventListener('close', resolve))
    const rotated = await (await call('POST', `/api/runners/${runner.id}/rotate`)).json<{ token: string }>()
    expect(rotated.token).not.toBe(runner.token)
    await closed
    expect((await worker.fetch(`${ORIGIN}/runner/connect`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${runner.token}` } })).status).toBe(401)

    const audit = await (await call('GET', '/api/audit')).json<any[]>()
    expect(audit.map(a => a.action)).toEqual(expect.arrayContaining(['runner.add', 'number.add', 'number.pairingCode', 'number.remove', 'runner.rotate']))
  })

  it('returns 409 for commands when the runner is offline, and validates input', async () => {
    const runner = await (await call('POST', '/api/runners', { body: { name: 'offline' } })).json<{ id: string }>()
    const number = await (await call('POST', '/api/numbers', { body: { name: 'Sales', runnerId: runner.id, agentId: 'a' } })).json<{ id: string }>()
    expect((await call('POST', `/api/numbers/${number.id}/actions/restart`)).status).toBe(409)
    expect((await call('POST', `/api/numbers/${number.id}/actions/format-disk`)).status).toBe(404)

    const bad = await call('POST', '/api/numbers', { body: { name: 'x', agentId: 'a', runnerId: 'missing' } })
    expect(bad.status).toBe(400)
    expect((await bad.json<any>()).errors).toContain('runnerId does not match any runner')
  })

  it('refuses cross-origin live connections', async () => {
    const res = await worker.fetch(`${ORIGIN}/api/live`, { headers: { Upgrade: 'websocket', Cookie: await sessionCookie(ADMIN), Origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
  })
})
