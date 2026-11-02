// Recorded WhatsApp messages: storing what runners report, listing chats, and exporting them.

// user: sent to the bot · ambient: a group message that didn't address the bot
// agent: the agent's reply · system: a notice or command reply from the bridge
// human: sent by a person from the linked phone · handoff: an alert sent to a human agent
export const KINDS = ['user', 'ambient', 'agent', 'system', 'human', 'handoff'] as const
export type Kind = (typeof KINDS)[number]

const MAX_TEXT = 20_000
const MAX_BATCH = 200

export type Media = { kind: string, mediaType?: string, filename?: string, size?: number }

export type MessageItem = {
  numberId: string
  id: string
  jid: string
  at: number
  direction: 'in' | 'out'
  kind: Kind
  sender: string | null
  senderName: string | null
  text: string | null
  media: Media | null
  waId: string | null
  chat: { ref: string | null, name: string | null, phone: string | null, isGroup: boolean }
}

const s = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null)
const JID = /^[^\s]{1,120}@(s\.whatsapp\.net|g\.us|lid)$/
const ID = /^[A-Za-z0-9_-]{8,64}$/
const REF = /^[A-Za-z0-9_-]{8,40}$/

// Runners are trusted to report on their own numbers, but the data still came from WhatsApp users
export function cleanItem(raw: unknown): MessageItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, any>
  if (typeof m.numberId !== 'string' || !ID.test(m.id ?? '') || !JID.test(m.jid ?? '')) return null
  if (!Number.isFinite(m.at) || (m.direction !== 'in' && m.direction !== 'out') || !KINDS.includes(m.kind)) return null
  const media = m.media && typeof m.media === 'object' ? {
    kind: s(m.media.kind, 20) ?? 'file',
    ...(s(m.media.mediaType, 100) && { mediaType: s(m.media.mediaType, 100)! }),
    ...(s(m.media.filename, 200) && { filename: s(m.media.filename, 200)! }),
    ...(Number.isFinite(m.media.size) && { size: Number(m.media.size) }),
  } : null
  const chat = m.chat && typeof m.chat === 'object' ? m.chat : {}
  return {
    numberId: m.numberId,
    id: m.id,
    jid: m.jid,
    at: Math.round(m.at),
    direction: m.direction,
    kind: m.kind,
    sender: s(m.sender, 64),
    senderName: s(m.senderName, 120),
    text: s(m.text, MAX_TEXT),
    media,
    waId: s(m.waId, 128),
    chat: {
      ref: typeof chat.ref === 'string' && REF.test(chat.ref) ? chat.ref : null,
      name: s(chat.name, 200),
      phone: s(chat.phone, 32),
      isGroup: m.jid.endsWith('@g.us'),
    },
  }
}

export const MAX_ITEMS_PER_BATCH = MAX_BATCH

export function storeStatements(db: D1Database, items: MessageItem[]): D1PreparedStatement[] {
  return items.flatMap(m => [
    db.prepare(`INSERT INTO chats (number_id, jid, ref, name, phone, is_group, first_at, last_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (number_id, jid) DO UPDATE SET
        ref = COALESCE(excluded.ref, chats.ref),
        name = COALESCE(excluded.name, chats.name),
        phone = COALESCE(excluded.phone, chats.phone),
        first_at = MIN(chats.first_at, excluded.first_at),
        last_at = MAX(chats.last_at, excluded.last_at)`)
      .bind(m.numberId, m.jid, m.chat.ref, m.chat.name, m.chat.phone, m.chat.isGroup ? 1 : 0, m.at, m.at),
    db.prepare(`INSERT OR IGNORE INTO messages (id, number_id, jid, at, direction, kind, sender, sender_name, text, media, wa_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(m.id, m.numberId, m.jid, m.at, m.direction, m.kind, m.sender, m.senderName, m.text, m.media ? JSON.stringify(m.media) : null, m.waId),
  ])
}

// Stores a batch. If the batch as a whole fails, each message is tried on its own so one bad
// row doesn't lose the rest. Returns how many messages could not be stored.
export async function storeMessages(db: D1Database, items: MessageItem[]): Promise<number> {
  if (!items.length) return 0
  try {
    await db.batch(storeStatements(db, items))
    return 0
  } catch {
    let failed = 0
    for (const m of items) {
      try { await db.batch(storeStatements(db, [m])) } catch (e) {
        failed++
        console.error(JSON.stringify({ message: 'could not store message', numberId: m.numberId, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return failed
  }
}

// ---------- Reading ----------

type MessageRow = { id: string, jid: string, at: number, direction: string, kind: string, sender: string | null, sender_name: string | null, text: string | null, media: string | null, wa_id: string | null }
type ChatRow = { jid: string, ref: string | null, name: string | null, phone: string | null, is_group: number, first_at: number, last_at: number, paused_until: number | null, messages: number, open_handoffs: number, last_text: string | null }

export const toMessage = (r: MessageRow) => ({
  id: r.id, jid: r.jid, at: r.at, direction: r.direction, kind: r.kind, sender: r.sender, senderName: r.sender_name,
  text: r.text, media: r.media ? JSON.parse(r.media) as Media : null, waId: r.wa_id,
})
export type StoredMessage = ReturnType<typeof toMessage>

export const toChat = (r: ChatRow) => ({
  jid: r.jid, name: r.name, phone: r.phone, isGroup: r.is_group === 1, firstAt: r.first_at, lastAt: r.last_at,
  pausedUntil: r.paused_until && r.paused_until > Date.now() ? r.paused_until : null,
  messages: r.messages, openHandoffs: r.open_handoffs, lastText: r.last_text,
})

const CHAT_COLUMNS = `c.jid, c.ref, c.name, c.phone, c.is_group, c.first_at, c.last_at, c.paused_until,
  (SELECT COUNT(*) FROM messages m WHERE m.number_id = c.number_id AND m.jid = c.jid) AS messages,
  (SELECT COUNT(*) FROM handoffs h WHERE h.number_id = c.number_id AND h.jid = c.jid AND h.status = 'open') AS open_handoffs,
  (SELECT m.text FROM messages m WHERE m.number_id = c.number_id AND m.jid = c.jid ORDER BY m.at DESC LIMIT 1) AS last_text`

// Newest chats first. `before` is the last_at of the last chat on the previous page.
export async function listChats(db: D1Database, numberId: string, { q, before, limit = 50 }: { q?: string, before?: number, limit?: number } = {}) {
  const where = ['c.number_id = ?']
  const args: unknown[] = [numberId]
  if (before) { where.push('c.last_at < ?'); args.push(before) }
  if (q) {
    where.push('(c.jid LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)')
    const like = `%${q.replace(/[%_]/g, '')}%`
    args.push(like, like, like)
  }
  const { results } = await db.prepare(`SELECT ${CHAT_COLUMNS} FROM chats c WHERE ${where.join(' AND ')} ORDER BY c.last_at DESC LIMIT ?`)
    .bind(...args, Math.min(limit, 200)).all<ChatRow>()
  return results.map(toChat)
}

export async function getChat(db: D1Database, numberId: string, jid: string) {
  const row = await db.prepare(`SELECT ${CHAT_COLUMNS} FROM chats c WHERE c.number_id = ? AND c.jid = ?`).bind(numberId, jid).first<ChatRow>()
  return row ? toChat(row) : null
}

// Oldest first, ending at the newest message before `before`
export async function listMessages(db: D1Database, numberId: string, jid: string, { before, limit = 100 }: { before?: number, limit?: number } = {}) {
  const { results } = await db.prepare(`SELECT * FROM messages WHERE number_id = ? AND jid = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?`)
    .bind(numberId, jid, before ?? Number.MAX_SAFE_INTEGER, Math.min(limit, 500)).all<MessageRow>()
  return results.reverse().map(toMessage)
}

// ---------- Export ----------

export type ExportFormat = 'jsonl' | 'csv'
export type ExportFilter = { jid?: string, from?: number, to?: number }

const CSV_COLUMNS = ['number', 'chat', 'chat_name', 'chat_phone', 'time', 'direction', 'kind', 'sender', 'sender_name', 'text', 'media_kind', 'media_type', 'media_filename', 'message_id'] as const

// Quotes every field, and stops spreadsheets from running text that starts like a formula
export function csvField(v: unknown): string {
  let t = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`
  return `"${t.replace(/"/g, '""')}"`
}

type ExportRow = MessageRow & { chat_name: string | null, chat_phone: string | null }

function exportLine(numberName: string, r: ExportRow, format: ExportFormat): string {
  const media = r.media ? JSON.parse(r.media) as Media : null
  if (format === 'jsonl') {
    return JSON.stringify({
      number: numberName, chat: r.jid, chatName: r.chat_name, chatPhone: r.chat_phone,
      time: new Date(r.at).toISOString(), at: r.at, direction: r.direction, kind: r.kind,
      sender: r.sender, senderName: r.sender_name, text: r.text, media, messageId: r.id,
    }) + '\n'
  }
  return [numberName, r.jid, r.chat_name, r.chat_phone, new Date(r.at).toISOString(), r.direction, r.kind, r.sender, r.sender_name,
    r.text, media?.kind, media?.mediaType, media?.filename, r.id].map(csvField).join(',') + '\r\n'
}

const PAGE = 500

// Streams every matching message, oldest first, reading D1 a page at a time
export function exportStream(db: D1Database, numberId: string, numberName: string, format: ExportFormat, filter: ExportFilter): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let cursor = { at: (filter.from ?? 0) - 1, id: '' }
  let started = false
  let done = false
  return new ReadableStream({
    async pull(controller) {
      if (!started) {
        started = true
        if (format === 'csv') controller.enqueue(enc.encode('﻿' + CSV_COLUMNS.join(',') + '\r\n'))
      }
      if (done) return controller.close()
      const where = ['m.number_id = ?', '(m.at > ? OR (m.at = ? AND m.id > ?))']
      const args: unknown[] = [numberId, cursor.at, cursor.at, cursor.id]
      if (filter.jid) { where.push('m.jid = ?'); args.push(filter.jid) }
      if (filter.to) { where.push('m.at <= ?'); args.push(filter.to) }
      const { results } = await db.prepare(`SELECT m.*, c.name AS chat_name, c.phone AS chat_phone FROM messages m
        LEFT JOIN chats c ON c.number_id = m.number_id AND c.jid = m.jid
        WHERE ${where.join(' AND ')} ORDER BY m.at, m.id LIMIT ${PAGE}`).bind(...args).all<ExportRow>()
      if (results.length) {
        controller.enqueue(enc.encode(results.map(r => exportLine(numberName, r, format)).join('')))
        const last = results[results.length - 1]
        cursor = { at: last.at, id: last.id }
      }
      if (results.length < PAGE) done = true
    },
  })
}

// ---------- Retention ----------

// Deletes messages older than `days`, and chats left with no messages and no open handoff
export async function purgeOldMessages(db: D1Database, days: number, now = Date.now()): Promise<number> {
  const cutoff = now - days * 86_400_000
  const res = await db.prepare('DELETE FROM messages WHERE at < ?').bind(cutoff).run()
  await db.prepare(`DELETE FROM chats WHERE last_at < ? AND NOT EXISTS
    (SELECT 1 FROM handoffs h WHERE h.number_id = chats.number_id AND h.jid = chats.jid AND h.status = 'open')`).bind(cutoff).run()
  return res.meta.changes ?? 0
}
