// Human handoff: alert the number's human agents on WhatsApp and pause the bot in the chat.

import { audit, DEFAULT_PAUSE_MINUTES, toHumanAgent, type HumanAgent } from './db'
import { listMessages, type StoredMessage } from './conversations'
import { HUB_NAME } from './hub'
import { normalizeTopic } from './validate'

const DEDUPE_MS = 10 * 60_000
const RECENT_MESSAGES = 10
const SNIPPET = 300

export type Urgency = 'normal' | 'urgent'
export type FollowupRequest = { chatRef: string, reason: string, summary?: string | null, topic?: string | null, urgency?: Urgency, requestedBy: string, origin: string }
export type ToolOutcome = { ok: boolean, text: string }

type ChatContext = {
  number_id: string, jid: string, name: string | null, phone: string | null, is_group: number
  number_name: string, runner_id: string | null, handoff_enabled: number, handoff_pause_minutes: number | null
}

async function chatByRef(db: D1Database, ref: string): Promise<ChatContext | null> {
  return db.prepare(`SELECT c.number_id, c.jid, c.name, c.phone, c.is_group, n.name AS number_name, n.runner_id,
      n.handoff_enabled, n.handoff_pause_minutes
    FROM chats c JOIN numbers n ON n.id = c.number_id WHERE c.ref = ?`).bind(ref.trim()).first<ChatContext>()
}

const unknownRef = 'Unknown chat_ref. Copy it exactly from the "[chat_ref=…]" line at the start of the user\'s latest message.'

async function humanAgents(db: D1Database, numberId: string): Promise<HumanAgent[]> {
  const { results } = await db.prepare('SELECT * FROM human_agents WHERE number_id = ? ORDER BY position').bind(numberId).all<any>()
  return results.map(toHumanAgent)
}

// On-duty agents for the topic. Agents with no topics take anything; if nobody matches the topic,
// everyone on duty is alerted rather than no one.
export function pickAgents(agents: HumanAgent[], topic?: string | null): HumanAgent[] {
  const onDuty = agents.filter(a => a.onDuty)
  if (!topic) return onDuty
  const t = normalizeTopic(topic)
  const matched = onDuty.filter(a => !a.topics.length || a.topics.includes(t))
  return matched.some(a => a.topics.includes(t)) ? matched : onDuty
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

function who(m: StoredMessage): string {
  if (m.direction === 'in') return m.senderName || (m.sender ? `+${m.sender}` : 'User')
  return m.kind === 'agent' ? 'Bot' : m.kind === 'human' ? 'Staff' : 'Bridge'
}

export function alertText(o: {
  numberName: string, chatName: string | null, isGroup: boolean, customer: { name: string | null, phone: string | null }
  reason: string, summary?: string | null, topic?: string | null, urgency: Urgency, recent: StoredMessage[], pauseMinutes: number, link: string
}): string {
  const customer = [o.customer.name, o.customer.phone && `+${o.customer.phone}`].filter(Boolean).join(' ') || 'unknown'
  const lines = [
    `${o.urgency === 'urgent' ? '🚨 URGENT: ' : '🙋 '}Human follow-up requested on ${o.numberName}`,
    o.isGroup ? `Group: ${o.chatName ?? 'unnamed'} · requested by ${customer}` : `Customer: ${customer}`,
    o.customer.phone && `Reply to them: https://wa.me/${o.customer.phone}`,
    o.topic && `Topic: ${o.topic}`,
    `Reason: ${o.reason}`,
    o.summary && `Summary: ${o.summary}`,
  ]
  const recent = o.recent.filter(m => m.kind !== 'handoff' && (m.text || m.media))
  if (recent.length) {
    lines.push('', 'Recent messages:')
    for (const m of recent) lines.push(`${who(m)}: ${clip(m.text || `(${m.media?.kind ?? 'file'}${m.media?.filename ? ` ${m.media.filename}` : ''})`, SNIPPET)}`)
  }
  lines.push('', o.pauseMinutes > 0
    ? `The bot is quiet in this chat for ${o.pauseMinutes} min. Resume it or read the full chat: ${o.link}`
    : `Full chat: ${o.link}`)
  // Optional lines are null or false when they don't apply; '' is a deliberate blank line
  return lines.filter(l => typeof l === 'string').join('\n')
}

type Delivery = { phone: string, ok: boolean, error?: string }

export async function requestFollowup(env: Env, req: FollowupRequest): Promise<ToolOutcome> {
  const db = env.DB
  const chat = await chatByRef(db, req.chatRef)
  if (!chat) return { ok: false, text: unknownRef }
  if (!chat.handoff_enabled) return { ok: false, text: 'Human handoff is turned off for this WhatsApp number. Tell the user you cannot connect them to a person here.' }

  // The model may call the tool twice in one run, or the user may ask again: alert once
  const recentOpen = await db.prepare(`SELECT at, notified FROM handoffs WHERE number_id = ? AND jid = ? AND status = 'open' AND at > ? ORDER BY at DESC LIMIT 1`)
    .bind(chat.number_id, chat.jid, Date.now() - DEDUPE_MS).first<{ at: number, notified: string }>()
  if (recentOpen) {
    const names = (JSON.parse(recentOpen.notified) as Array<{ name: string, ok: boolean }>).filter(n => n.ok).map(n => n.name)
    return { ok: true, text: `A human follow-up was already requested ${Math.round((Date.now() - recentOpen.at) / 60_000)} min ago${names.length ? ` (${names.join(', ')} alerted)` : ''}. Tell the user a person will contact them soon.` }
  }

  const agents = pickAgents(await humanAgents(db, chat.number_id), req.topic)
  const pauseMinutes = chat.handoff_pause_minutes ?? DEFAULT_PAUSE_MINUTES
  const recent = await listMessages(db, chat.number_id, chat.jid, { limit: RECENT_MESSAGES })
  const lastUser = [...recent].reverse().find(m => m.direction === 'in' && m.kind === 'user')
  const customer = chat.is_group
    ? { name: lastUser?.senderName ?? null, phone: lastUser?.sender ?? null }
    : { name: chat.name ?? lastUser?.senderName ?? null, phone: chat.phone ?? lastUser?.sender ?? null }
  const link = `${req.origin}/#/numbers/${chat.number_id}/chats/${encodeURIComponent(chat.jid)}`
  const urgency: Urgency = req.urgency === 'urgent' ? 'urgent' : 'normal'

  let deliveries: Delivery[] = []
  let pausedUntil: number | null = null
  let failure: string | null = null
  if (!agents.length) failure = 'No human agent is on duty for this number.'
  else if (!chat.runner_id) failure = 'This WhatsApp number is not running.'
  else {
    const text = alertText({ numberName: chat.number_name, chatName: chat.name, isGroup: chat.is_group === 1, customer, reason: req.reason,
      summary: req.summary, topic: req.topic, urgency, recent, pauseMinutes, link })
    const outcome = await env.HUB.getByName(HUB_NAME).request(chat.runner_id, chat.number_id, 'handoff',
      { jid: chat.jid, recipients: agents.map(a => a.phone), text, pauseMinutes })
    if (!outcome.ok) failure = `The WhatsApp alert could not be sent (${outcome.error}).`
    else {
      const result = JSON.parse(outcome.result) as { results?: Delivery[], pausedUntil?: number | null }
      deliveries = result.results ?? []
      pausedUntil = result.pausedUntil ?? null
      if (!deliveries.some(d => d.ok)) failure = 'None of the human agents could be reached on WhatsApp.'
    }
  }

  const notified = agents.map(a => {
    const d = deliveries.find(x => x.phone === a.phone)
    return { name: a.name, phone: a.phone, ok: Boolean(d?.ok), ...(d?.error && { error: d.error }) }
  })
  const id = crypto.randomUUID()
  await db.batch([
    db.prepare(`INSERT INTO handoffs (id, number_id, jid, at, reason, summary, topic, urgency, status, notified, requested_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, chat.number_id, chat.jid, Date.now(), req.reason, req.summary ?? null,
      req.topic ? normalizeTopic(req.topic) : null, urgency, failure ? 'failed' : 'open', JSON.stringify(notified), req.requestedBy),
    ...(pausedUntil ? [db.prepare('UPDATE chats SET paused_until = ? WHERE number_id = ? AND jid = ?').bind(pausedUntil, chat.number_id, chat.jid)] : []),
  ])
  await audit(db, req.requestedBy, 'handoff.request', chat.number_id, { handoff: id, chat: chat.jid, alerted: notified.filter(n => n.ok).length, ...(failure && { failure }) })

  if (failure) return { ok: false, text: `${failure} The request was logged on the dashboard. Tell the user a person can't be reached right now and offer to keep helping.` }
  const names = notified.filter(n => n.ok).map(n => n.name)
  return { ok: true, text: `Alerted ${names.join(', ')} on WhatsApp. Tell the user a person will contact them soon${pausedUntil ? '; the bot will stay quiet in this chat in the meantime' : ''}.` }
}

export async function listTopics(env: Env, chatRef: string): Promise<ToolOutcome> {
  const chat = await chatByRef(env.DB, chatRef)
  if (!chat) return { ok: false, text: unknownRef }
  if (!chat.handoff_enabled) return { ok: false, text: 'Human handoff is turned off for this WhatsApp number.' }
  const onDuty = (await humanAgents(env.DB, chat.number_id)).filter(a => a.onDuty)
  if (!onDuty.length) return { ok: true, text: 'No human agent is on duty right now.' }
  const counts = new Map<string, number>()
  for (const a of onDuty) for (const t of a.topics) counts.set(t, (counts.get(t) ?? 0) + 1)
  const general = onDuty.filter(a => !a.topics.length).length
  const lines = [...counts].sort().map(([t, n]) => `- ${t}: ${n} on duty`)
  if (general) lines.push(`- (any topic): ${general} on duty`)
  return { ok: true, text: `Topics you can pass to request_human_followup:\n${lines.join('\n')}` }
}
