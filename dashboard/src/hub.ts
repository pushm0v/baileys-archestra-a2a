// The hub: one Durable Object that holds every runner's WebSocket and every open dashboard tab.
// Runners report status, QR codes and logs here; the hub relays them to browsers and sends
// settings and commands down to runners. Traffic is a handful of admins and runners, so one
// instance is enough.
//
// Live status, the current QR code and recent log lines are kept in the object's own SQLite
// storage (not D1) so they survive hibernation. A QR code is deleted as soon as the number is
// linked or stopped; logs keep the last LOG_LINES lines per number.

import { DurableObject } from 'cloudflare:workers'
import { runnerPayload } from './db'

export const HUB_NAME = 'global'
const REQUEST_TIMEOUT_MS = 35_000
const LOG_LINES = 200
const SNAPSHOT_LOG_LINES = 50

type Attachment =
  | { kind: 'runner', runnerId: string }
  | { kind: 'browser', email: string, exp: number }

export type LiveStatus = {
  runnerId: string
  state: string
  detail?: string | null
  phone?: string | null
  pushName?: string | null
  at?: number
  lastMessageAt?: number | null
  messageCount?: number
}

type LogLine = { stream: string, line: string, at: number }

type RunnerMessage =
  | { type: 'hello', version?: string, statuses?: Array<{ numberId: string } & Partial<LiveStatus>> }
  | ({ type: 'status', numberId: string } & Partial<LiveStatus>)
  | { type: 'qr', numberId: string, svg: string | null }
  | { type: 'activity', numberId: string, at: number, count: number }
  | { type: 'log', numberId: string, stream: string, line: string, at: number }
  | { type: 'removed', numberId: string }
  | { type: 'response', id: string, ok: boolean, result?: unknown, error?: string }

// result is JSON text, so any shape the runner returns crosses the RPC boundary intact
export type RequestOutcome = { ok: true, result: string } | { ok: false, offline?: boolean, error: string }

export class Hub extends DurableObject<Env> {
  private pending = new Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  // numberId -> runnerId, so a runner can only report on numbers assigned to it
  private owners: Map<string, string> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS live (number_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS qr (number_id TEXT PRIMARY KEY, svg TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, number_id TEXT NOT NULL, stream TEXT, line TEXT, at INTEGER);
      CREATE INDEX IF NOT EXISTS logs_number ON logs(number_id, id);
    `)
    // Runner keepalives are answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // WebSocket upgrades, forwarded by the Worker after it has authenticated the caller
  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get('X-Hub-Kind')
    const { 0: client, 1: server } = new WebSocketPair()

    if (kind === 'runner') {
      const runnerId = request.headers.get('X-Hub-Runner')!
      // A runner has one connection; a reconnect replaces the old one
      for (const ws of this.ctx.getWebSockets(`runner:${runnerId}`)) ws.close(4000, 'replaced by a newer connection')
      this.ctx.acceptWebSocket(server, [`runner:${runnerId}`])
      server.serializeAttachment({ kind: 'runner', runnerId } satisfies Attachment)
      await this.touchRunner(runnerId)
      this.broadcast({ type: 'runner', runnerId, online: true })
    } else if (kind === 'browser') {
      const email = request.headers.get('X-Hub-Email')!
      const exp = Number(request.headers.get('X-Hub-Exp'))
      this.ctx.acceptWebSocket(server, ['browser', `browser:${email}`])
      server.serializeAttachment({ kind: 'browser', email, exp } satisfies Attachment)
      server.send(JSON.stringify(this.snapshot()))
    } else {
      return new Response('unknown connection kind', { status: 400 })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment
    if (att.kind !== 'runner' || typeof message !== 'string') return // browsers act through the REST API
    let msg: RunnerMessage
    try { msg = JSON.parse(message) } catch { return }
    await this.onRunnerMessage(att.runnerId, ws, msg)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws)
  }

  private async onSocketGone(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null
    if (att?.kind !== 'runner') return
    const others = this.ctx.getWebSockets(`runner:${att.runnerId}`).filter(s => s !== ws && s.readyState === WebSocket.OPEN)
    if (others.length) return
    await this.touchRunner(att.runnerId)
    this.broadcast({ type: 'runner', runnerId: att.runnerId, online: false })
  }

  private async touchRunner(runnerId: string) {
    await this.env.DB.prepare('UPDATE runners SET last_seen_at = ? WHERE id = ?').bind(Date.now(), runnerId).run()
  }

  private async ownerOf(numberId: string): Promise<string | undefined> {
    if (!this.owners) {
      const { results } = await this.env.DB.prepare('SELECT id, runner_id FROM numbers WHERE runner_id IS NOT NULL').all<{ id: string, runner_id: string }>()
      this.owners = new Map(results.map(r => [r.id, r.runner_id]))
    }
    return this.owners.get(numberId)
  }

  private async onRunnerMessage(runnerId: string, ws: WebSocket, msg: RunnerMessage) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'runner error'))
      return
    }
    if (msg.type === 'hello') {
      this.owners = null
      for (const s of msg.statuses ?? []) {
        if (await this.ownerOf(s.numberId) === runnerId) this.updateLive(s.numberId, runnerId, s)
      }
      ws.send(JSON.stringify({ type: 'sync', numbers: await runnerPayload(this.env.DB, runnerId) }))
      return
    }
    // Everything else is about one number, which must belong to this runner
    if (await this.ownerOf(msg.numberId) !== runnerId) return
    const id = msg.numberId

    if (msg.type === 'status') {
      const { type, numberId, ...status } = msg
      this.updateLive(id, runnerId, status)
    } else if (msg.type === 'activity') {
      const cur = this.readLive(id)
      this.updateLive(id, runnerId, { lastMessageAt: msg.at, messageCount: (cur?.messageCount ?? 0) + msg.count })
    } else if (msg.type === 'qr') {
      if (msg.svg) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO qr (number_id, svg) VALUES (?, ?)', id, msg.svg)
      else this.ctx.storage.sql.exec('DELETE FROM qr WHERE number_id = ?', id)
      this.broadcast({ type: 'qr', numberId: id, svg: msg.svg })
    } else if (msg.type === 'log') {
      const line = { stream: msg.stream, line: String(msg.line).slice(0, 2000), at: msg.at }
      const sql = this.ctx.storage.sql
      sql.exec('INSERT INTO logs (number_id, stream, line, at) VALUES (?, ?, ?, ?)', id, line.stream, line.line, line.at)
      sql.exec(`DELETE FROM logs WHERE number_id = ? AND id <= (SELECT id FROM logs WHERE number_id = ? ORDER BY id DESC LIMIT 1 OFFSET ${LOG_LINES})`, id, id)
      this.broadcast({ type: 'log', numberId: id, ...line })
    } else if (msg.type === 'removed') {
      this.ctx.storage.sql.exec('DELETE FROM qr WHERE number_id = ?', id)
    }
  }

  private readLive(numberId: string): LiveStatus | null {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM live WHERE number_id = ?', numberId).toArray()[0]
    return row ? JSON.parse(row.data) : null
  }

  private updateLive(numberId: string, runnerId: string, patch: Partial<LiveStatus>) {
    const next = { ...this.readLive(numberId), ...patch, runnerId } as LiveStatus
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO live (number_id, data) VALUES (?, ?)', numberId, JSON.stringify(next))
    this.broadcast({ type: 'status', numberId, ...next })
  }

  private onlineRunners(): string[] {
    const ids = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att?.kind === 'runner' && ws.readyState === WebSocket.OPEN) ids.add(att.runnerId)
    }
    return [...ids]
  }

  private snapshot() {
    const live: Record<string, LiveStatus> = {}
    for (const row of this.ctx.storage.sql.exec<{ number_id: string, data: string }>('SELECT number_id, data FROM live')) {
      live[row.number_id] = JSON.parse(row.data)
    }
    const sql = this.ctx.storage.sql
    const qrs: Record<string, string> = {}
    for (const row of sql.exec<{ number_id: string, svg: string }>('SELECT number_id, svg FROM qr')) qrs[row.number_id] = row.svg
    const logs: Record<string, LogLine[]> = {}
    const recent = sql.exec<{ number_id: string, stream: string, line: string, at: number }>(`SELECT number_id, stream, line, at FROM
      (SELECT *, ROW_NUMBER() OVER (PARTITION BY number_id ORDER BY id DESC) AS n FROM logs) WHERE n <= ${SNAPSHOT_LOG_LINES} ORDER BY id`)
    for (const r of recent) (logs[r.number_id] ??= []).push({ stream: r.stream, line: r.line, at: r.at })
    return { type: 'snapshot', onlineRunners: this.onlineRunners(), live, qrs, logs }
  }

  private broadcast(msg: object) {
    const data = JSON.stringify(msg)
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets('browser')) {
      const att = ws.deserializeAttachment() as Attachment
      // The tab's sign-in has expired: stop streaming to it
      if (att.kind === 'browser' && att.exp <= now) { ws.close(4401, 'session expired'); continue }
      try { ws.send(data) } catch { /* closing */ }
    }
  }

  // ---- RPC, called by the Worker ----

  isRunnerOnline(runnerId: string): boolean {
    return this.ctx.getWebSockets(`runner:${runnerId}`).some(ws => ws.readyState === WebSocket.OPEN)
  }

  listOnlineRunners(): string[] {
    return this.onlineRunners()
  }

  // Push current settings to a runner. Returns false when it is offline (it gets them on reconnect).
  async syncRunner(runnerId: string): Promise<boolean> {
    this.owners = null
    const sockets = this.ctx.getWebSockets(`runner:${runnerId}`)
    if (!sockets.length) return false
    const data = JSON.stringify({ type: 'sync', numbers: await runnerPayload(this.env.DB, runnerId) })
    for (const ws of sockets) ws.send(data)
    return true
  }

  // Send a command to a runner and wait for its answer. Never throws: failures come back as
  // { ok: false, error }, since errors crossing the RPC boundary lose their type.
  async request(runnerId: string, numberId: string, action: string, args: Record<string, string> = {}): Promise<RequestOutcome> {
    const ws = this.ctx.getWebSockets(`runner:${runnerId}`).find(s => s.readyState === WebSocket.OPEN)
    if (!ws) return { ok: false, offline: true, error: 'The runner for this number is offline' }
    const id = crypto.randomUUID()
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${action} timed out`)) }, REQUEST_TIMEOUT_MS)
        this.pending.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ type: 'request', id, numberId, action, args }))
      })
      return { ok: true, result: JSON.stringify(result ?? null) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  disconnectRunner(runnerId: string): void {
    for (const ws of this.ctx.getWebSockets(`runner:${runnerId}`)) ws.close(4003, 'runner token revoked')
  }

  disconnectBrowser(email: string): void {
    for (const ws of this.ctx.getWebSockets(`browser:${email}`)) ws.close(4403, 'access removed')
  }

  // Drop live state for a number that was deleted or moved to another runner
  forgetNumber(numberId: string): void {
    for (const table of ['live', 'qr', 'logs']) this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE number_id = ?`, numberId)
    this.owners = null
    this.broadcast({ type: 'cleared', numberId })
  }
}
