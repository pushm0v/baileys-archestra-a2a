// Per-chat state for message recording and human handoff:
//  - chat refs: a random ID per chat that the agent passes to the handoff tool, so the tool knows
//    which chat to act on without the model ever seeing (or being able to guess) a phone number
//  - pauses: chats where the bot stays quiet because a human is taking over

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'

function jsonMap(file) {
  let data = {}
  if (file && fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = {} }
  }
  const save = () => file && fs.writeFileSync(file, JSON.stringify(data, null, 2))
  return { data, save }
}

export function createChatRefs(file) {
  const { data, save } = jsonMap(file)
  return {
    // Created on first use and kept for good, so a ref the agent saw earlier in a conversation keeps working
    get(jid) {
      if (!data[jid]) { data[jid] = `c${randomBytes(12).toString('base64url')}`; save() }
      return data[jid]
    },
  }
}

export function createPauses(file, now = Date.now) {
  const { data, save } = jsonMap(file)
  return {
    // Returns the time the pause ends
    pause(jid, minutes) {
      data[jid] = now() + minutes * 60_000
      save()
      return data[jid]
    },
    resume(jid) {
      if (jid in data) { delete data[jid]; save() }
    },
    until(jid) {
      const t = data[jid]
      if (!t) return null
      if (t <= now()) { delete data[jid]; save(); return null }
      return t
    },
  }
}

// Text the agent sees first in every message, so it can pass the chat to the handoff tool
export const chatRefLine = ref => `[chat_ref=${ref}]`

export function withChatRef(parts, ref) {
  if (!ref || !parts.length) return parts
  const [first, ...rest] = parts
  if (first.text === undefined) return [{ text: chatRefLine(ref) }, ...parts]
  return [{ ...first, text: `${chatRefLine(ref)}\n${first.text}` }, ...rest]
}

/**
 * A recorded message, in the shape the dashboard stores (see dashboard/src/conversations.ts).
 * kind: user | ambient | agent | system | human | handoff
 */
export function messageRecord({ jid, direction, kind, text = null, media = null, sender = null, senderName = null, waId = null, at = Date.now(), chat = {} }) {
  return {
    type: 'message',
    id: randomUUID(),
    jid,
    at,
    direction,
    kind,
    sender,
    senderName,
    text,
    media: media && { kind: media.kind, mediaType: media.mediaType, filename: media.filename, size: media.size || undefined },
    waId,
    chat: { ref: chat.ref ?? null, name: chat.name ?? null, phone: chat.phone ?? null },
  }
}

// IDs of messages the bridge sent itself, so the echo WhatsApp sends back isn't recorded twice
export function createSentIds(max = 2000) {
  const ids = new Set()
  return {
    add(id) {
      ids.add(id)
      if (ids.size > max) ids.delete(ids.values().next().value)
    },
    has: id => ids.has(id),
  }
}
