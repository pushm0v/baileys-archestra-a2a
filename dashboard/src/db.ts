// D1 queries, and the settings payload sent to runners.

import type { NumberInput, RouteInput } from './validate'

type NumberRow = {
  id: string; name: string; runner_id: string | null; enabled: number; agent_id: string
  archestra_url: string | null; token_ref: string | null; allowed_numbers: string
  media_types: string | null; max_media_mb: number | null; media_inline: string | null
  agent_timeout_ms: number | null; created_at: number; updated_at: number
}
type RouteRow = {
  number_id: string; key: string; name: string | null; agent_id: string; url: string | null
  token_ref: string | null; trigger: string; allowed_numbers: string | null
}

export type NumberRecord = NumberInput & { id: string, createdAt: number, updatedAt: number }

const toRoute = (r: RouteRow): RouteInput => ({
  key: r.key,
  name: r.name,
  agentId: r.agent_id,
  url: r.url,
  tokenRef: r.token_ref,
  trigger: r.trigger as RouteInput['trigger'],
  allowedNumbers: r.allowed_numbers ? JSON.parse(r.allowed_numbers) : null,
})

const toNumber = (n: NumberRow, routes: RouteRow[]): NumberRecord => ({
  id: n.id,
  name: n.name,
  runnerId: n.runner_id,
  enabled: n.enabled === 1,
  agentId: n.agent_id,
  archestraUrl: n.archestra_url,
  tokenRef: n.token_ref,
  allowedNumbers: JSON.parse(n.allowed_numbers),
  mediaTypes: n.media_types ? JSON.parse(n.media_types) : null,
  maxMediaMb: n.max_media_mb,
  mediaInline: n.media_inline as NumberInput['mediaInline'],
  agentTimeoutMs: n.agent_timeout_ms,
  routes: routes.filter(r => r.number_id === n.id).map(toRoute),
  createdAt: n.created_at,
  updatedAt: n.updated_at,
})

export async function listNumbers(db: D1Database, runnerId?: string): Promise<NumberRecord[]> {
  const [numbers, routes] = runnerId
    ? await db.batch<NumberRow | RouteRow>([
        db.prepare('SELECT * FROM numbers WHERE runner_id = ? ORDER BY name').bind(runnerId),
        db.prepare('SELECT r.* FROM routes r JOIN numbers n ON n.id = r.number_id WHERE n.runner_id = ? ORDER BY r.key').bind(runnerId),
      ])
    : await db.batch<NumberRow | RouteRow>([
        db.prepare('SELECT * FROM numbers ORDER BY name'),
        db.prepare('SELECT * FROM routes ORDER BY key'),
      ])
  return (numbers.results as NumberRow[]).map(n => toNumber(n, routes.results as RouteRow[]))
}

export async function getNumber(db: D1Database, id: string): Promise<NumberRecord | null> {
  const [numbers, routes] = await db.batch<NumberRow | RouteRow>([
    db.prepare('SELECT * FROM numbers WHERE id = ?').bind(id),
    db.prepare('SELECT * FROM routes WHERE number_id = ? ORDER BY key').bind(id),
  ])
  const n = numbers.results[0] as NumberRow | undefined
  return n ? toNumber(n, routes.results as RouteRow[]) : null
}

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v))

// Insert or replace a number and all its routes in one transaction
export async function saveNumber(db: D1Database, id: string, n: NumberInput, { create }: { create: boolean }): Promise<void> {
  const now = Date.now()
  const values = [n.name, n.runnerId, n.enabled ? 1 : 0, n.agentId, n.archestraUrl, n.tokenRef, JSON.stringify(n.allowedNumbers),
    json(n.mediaTypes), n.maxMediaMb, n.mediaInline, n.agentTimeoutMs]
  const write = create
    ? db.prepare(`INSERT INTO numbers (name, runner_id, enabled, agent_id, archestra_url, token_ref, allowed_numbers, media_types,
        max_media_mb, media_inline, agent_timeout_ms, id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...values, id, now, now)
    : db.prepare(`UPDATE numbers SET name=?, runner_id=?, enabled=?, agent_id=?, archestra_url=?, token_ref=?, allowed_numbers=?,
        media_types=?, max_media_mb=?, media_inline=?, agent_timeout_ms=?, updated_at=? WHERE id=?`).bind(...values, now, id)
  await db.batch([
    write,
    db.prepare('DELETE FROM routes WHERE number_id = ?').bind(id),
    ...n.routes.map(r => db.prepare(`INSERT INTO routes (number_id, key, name, agent_id, url, token_ref, trigger, allowed_numbers)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, r.key, r.name, r.agentId, r.url, r.tokenRef, r.trigger, json(r.allowedNumbers))),
  ])
}

export async function audit(db: D1Database, email: string, action: string, target: string | null, detail?: unknown): Promise<void> {
  await db.prepare('INSERT INTO audit_log (at, email, action, target, detail) VALUES (?,?,?,?,?)')
    .bind(Date.now(), email, action, target, detail === undefined ? null : JSON.stringify(detail)).run()
}

// Settings for one runner, in the shape src/runner/config.mjs expects. Contains no secrets.
export async function runnerPayload(db: D1Database, runnerId: string) {
  const numbers = await listNumbers(db, runnerId)
  return numbers.map(n => ({
    id: n.id,
    name: n.name,
    enabled: n.enabled,
    agentId: n.agentId,
    archestraUrl: n.archestraUrl,
    tokenRef: n.tokenRef,
    allowedNumbers: n.allowedNumbers,
    mediaTypes: n.mediaTypes,
    maxMediaMb: n.maxMediaMb,
    mediaInline: n.mediaInline,
    agentTimeoutMs: n.agentTimeoutMs,
    routes: Object.fromEntries(n.routes.map(r => [r.key, {
      ...(r.name && { name: r.name }),
      agentId: r.agentId,
      ...(r.url && { url: r.url }),
      ...(r.tokenRef && { tokenRef: r.tokenRef }),
      trigger: r.trigger,
      ...(r.allowedNumbers?.length && { allowedNumbers: r.allowedNumbers }),
    }])),
  }))
}
