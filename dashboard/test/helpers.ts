// Shared helpers for the Worker tests: signed-in requests and WebSocket clients.

import { expect } from 'vitest'
import { exports } from 'cloudflare:workers'
import { sign } from '../src/crypto'

export const ORIGIN = 'https://dash.example.com'
export const SECRET = 'test-session-secret'
export const ADMIN = 'boss@example.com'

export const worker = exports.default as unknown as Fetcher

export async function sessionCookie(email: string, exp = Date.now() + 60_000) {
  return `__Host-session=${await sign({ email, exp }, SECRET)}`
}

export async function call(method: string, path: string, { email = ADMIN as string | null, body, origin = true }: { email?: string | null, body?: unknown, origin?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (email) headers.Cookie = await sessionCookie(email)
  if (origin) headers.Origin = ORIGIN
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return worker.fetch(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
}

// WebSocket client that buffers messages so tests can wait for a specific one
export function client(ws: WebSocket) {
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

export async function connectRunner(token: string) {
  const res = await worker.fetch(`${ORIGIN}/runner/connect`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } })
  expect(res.status).toBe(101)
  return client(res.webSocket!)
}

export async function connectBrowser(email = ADMIN) {
  const res = await worker.fetch(`${ORIGIN}/api/live`, { headers: { Upgrade: 'websocket', Cookie: await sessionCookie(email), Origin: ORIGIN } })
  expect(res.status).toBe(101)
  return client(res.webSocket!)
}
