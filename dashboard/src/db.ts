// D1 queries, and the settings payload sent to runners.

import type { HumanAgentInput, NumberInput, RouteInput } from './validate'

type NumberRow = {
  id: string; name: string; runner_id: string | null; enabled: number; agent_id: string
  archestra_url: string | null; token_ref: string | null; allowed_numbers: string
  media_types: string | null; max_media_mb: number | null; media_inline: string | null
  agent_timeout_ms: number | null; created_at: number; updated_at: number
  record_messages: number; handoff_enabled: number; handoff_pause_minutes: number | null
}
type HumanAgentRow = { id: string; number_id: string; name: string; phone: string; topics: string; on_duty: number; position: number }

export const DEFAULT_PAUSE_MINUTES = 60
export type HumanAgent = HumanAgentInput & { id: string }
type RouteRow = {
  number_id: string; key: string; name: string | null; agent_id: string; url: string | null
  token_ref: string | null; trigger: string; allowed_numbers: string | null
}

export type NumberRecord = Omit<NumberInput, 'humanAgents'> & { id: string, createdAt: number, updatedAt: number, humanAgents: HumanAgent[] }

export const toHumanAgent = (a: HumanAgentRow): HumanAgent => ({ id: a.id, name: a.name, phone: a.phone, topics: JSON.parse(a.topics), onDuty: a.on_duty === 1 })

const toRoute = (r: RouteRow): RouteInput => ({
  key: r.key,
  name: r.name,
  agentId: r.agent_id,
  url: r.url,
  tokenRef: r.token_ref,
  trigger: r.trigger as RouteInput['trigger'],
  allowedNumbers: r.allowed_numbers ? JSON.parse(r.allowed_numbers) : null,
})

const toNumber = (n: NumberRow, routes: RouteRow[], agents: HumanAgentRow[]): NumberRecord => ({
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
  recordMessages: n.record_messages === 1,
  handoffEnabled: n.handoff_enabled === 1,
  handoffPauseMinutes: n.handoff_pause_minutes,
  humanAgents: agents.filter(a => a.number_id === n.id).map(toHumanAgent),
  createdAt: n.created_at,
  updatedAt: n.updated_at,
})

export async function listNumbers(db: D1Database, runnerId?: string): Promise<NumberRecord[]> {
  const [numbers, routes, agents] = runnerId
    ? await db.batch<NumberRow | RouteRow | HumanAgentRow>([
        db.prepare('SELECT * FROM numbers WHERE runner_id = ? ORDER BY name').bind(runnerId),
        db.prepare('SELECT r.* FROM routes r JOIN numbers n ON n.id = r.number_id WHERE n.runner_id = ? ORDER BY r.key').bind(runnerId),
        db.prepare('SELECT a.* FROM human_agents a JOIN numbers n ON n.id = a.number_id WHERE n.runner_id = ? ORDER BY a.position').bind(runnerId),
      ])
    : await db.batch<NumberRow | RouteRow | HumanAgentRow>([
        db.prepare('SELECT * FROM numbers ORDER BY name'),
        db.prepare('SELECT * FROM routes ORDER BY key'),
        db.prepare('SELECT * FROM human_agents ORDER BY position'),
      ])
  return (numbers.results as NumberRow[]).map(n => toNumber(n, routes.results as RouteRow[], agents.results as HumanAgentRow[]))
}

export async function getNumber(db: D1Database, id: string): Promise<NumberRecord | null> {
  const [numbers, routes, agents] = await db.batch<NumberRow | RouteRow | HumanAgentRow>([
    db.prepare('SELECT * FROM numbers WHERE id = ?').bind(id),
    db.prepare('SELECT * FROM routes WHERE number_id = ? ORDER BY key').bind(id),
    db.prepare('SELECT * FROM human_agents WHERE number_id = ? ORDER BY position').bind(id),
  ])
  const n = numbers.results[0] as NumberRow | undefined
  return n ? toNumber(n, routes.results as RouteRow[], agents.results as HumanAgentRow[]) : null
}

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v))

// Insert or replace a number and all its routes in one transaction
export async function saveNumber(db: D1Database, id: string, n: NumberInput, { create }: { create: boolean }): Promise<void> {
  const now = Date.now()
  const values = [n.name, n.runnerId, n.enabled ? 1 : 0, n.agentId, n.archestraUrl, n.tokenRef, JSON.stringify(n.allowedNumbers),
    json(n.mediaTypes), n.maxMediaMb, n.mediaInline, n.agentTimeoutMs, n.recordMessages ? 1 : 0, n.handoffEnabled ? 1 : 0, n.handoffPauseMinutes]
  const write = create
    ? db.prepare(`INSERT INTO numbers (name, runner_id, enabled, agent_id, archestra_url, token_ref, allowed_numbers, media_types,
        max_media_mb, media_inline, agent_timeout_ms, record_messages, handoff_enabled, handoff_pause_minutes, id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...values, id, now, now)
    : db.prepare(`UPDATE numbers SET name=?, runner_id=?, enabled=?, agent_id=?, archestra_url=?, token_ref=?, allowed_numbers=?,
        media_types=?, max_media_mb=?, media_inline=?, agent_timeout_ms=?, record_messages=?, handoff_enabled=?, handoff_pause_minutes=?,
        updated_at=? WHERE id=?`).bind(...values, now, id)
  await db.batch([
    write,
    db.prepare('DELETE FROM routes WHERE number_id = ?').bind(id),
    ...n.routes.map(r => db.prepare(`INSERT INTO routes (number_id, key, name, agent_id, url, token_ref, trigger, allowed_numbers)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, r.key, r.name, r.agentId, r.url, r.tokenRef, r.trigger, json(r.allowedNumbers))),
    db.prepare('DELETE FROM human_agents WHERE number_id = ?').bind(id),
    ...n.humanAgents.map((a, i) => db.prepare(`INSERT INTO human_agents (id, number_id, name, phone, topics, on_duty, position)
      VALUES (?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), id, a.name, a.phone, JSON.stringify(a.topics), a.onDuty ? 1 : 0, i)),
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
    // Human agents stay in the dashboard: the runner only needs to know whether to record and hand off
    recordMessages: n.recordMessages,
    handoff: n.handoffEnabled,
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
