// WhatsApp (Baileys) -> Archestra agent bridge over the A2A v2 protocol.
// Config comes from environment variables; see .env.example.

import makeWASocket, { useMultiFileAuthState, DisconnectReason, generateMessageIDV2 } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import { inspectMessage, buildParts } from './media.mjs'
import { createAgentClient, createContextStore } from './agent.mjs'
import { loadRoutes, parseRoutes, botIds, isMentioned, stripMentions, userOf } from './routes.mjs'
import { reconnectDelay } from './backoff.mjs'
import { createChatRefs, createPauses, createSentIds, messageRecord, withChatRef } from './chatlog.mjs'

const {
  ARCHESTRA_URL,
  ARCHESTRA_AGENT_ID,
  ARCHESTRA_TOKEN,
  DATA_DIR = './data',
  AGENT_TIMEOUT_MS = String(5 * 60_000),
  LOG_LEVEL = 'warn',
  MEDIA_TYPES = 'image,document',
  MAX_MEDIA_MB = '10',
  MEDIA_INLINE = 'auto',
} = process.env
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(DATA_DIR, 'routes.json')

// Started by the runner (src/runner.mjs): report status over IPC and take commands from it
const MANAGED = typeof process.send === 'function'
const report = msg => { if (MANAGED) process.send(msg) }

// Recording needs the dashboard to store messages, so it only runs under a runner.
// Handoff adds a chat_ref line to every message so the agent can call the dashboard's handoff tool.
const RECORD = MANAGED && process.env.RECORD_MESSAGES !== '0'
const HANDOFF = process.env.HANDOFF_ENABLED === '1'

for (const [k, v] of Object.entries({ ARCHESTRA_URL, ARCHESTRA_AGENT_ID, ARCHESTRA_TOKEN })) {
  if (!v) { console.error(`Missing required env var ${k}`); process.exit(1) }
}
if (!['auto', 'always', 'never'].includes(MEDIA_INLINE)) {
  console.error('MEDIA_INLINE must be auto, always or never'); process.exit(1)
}

const ALLOWED = new Set((process.env.ALLOWED_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean))
if (!ALLOWED.size) console.warn('ALLOWED_NUMBERS is empty: anyone who messages this number can reach the agent')

const logger = pino({ level: LOG_LEVEL })
fs.mkdirSync(DATA_DIR, { recursive: true })
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const endpointOf = (url, agentId) => `${url.replace(/\/$/, '')}/v2/a2a/${agentId}`
const A2A_ENDPOINT = endpointOf(ARCHESTRA_URL, ARCHESTRA_AGENT_ID)

const contexts = createContextStore(path.join(DATA_DIR, 'contexts.json'))
const chatRefs = createChatRefs(path.join(DATA_DIR, 'chat-refs.json'))
const pauses = createPauses(path.join(DATA_DIR, 'paused.json'))
const sentIds = createSentIds()
const clientOptions = { store: contexts, timeoutMs: Number(AGENT_TIMEOUT_MS), mediaInline: MEDIA_INLINE, logger: console }

// Default agent: direct chats without their own route
const defaultAgent = createAgentClient({ ...clientOptions, endpoint: A2A_ENDPOINT, token: ARCHESTRA_TOKEN })

let routes
try {
  const routeOptions = { url: ARCHESTRA_URL, token: ARCHESTRA_TOKEN, env: process.env }
  // ROUTES_JSON (set by the runner) takes precedence over the routes file
  routes = process.env.ROUTES_JSON
    ? parseRoutes(JSON.parse(process.env.ROUTES_JSON), routeOptions)
    : loadRoutes(ROUTES_FILE, routeOptions)
} catch (e) {
  console.error(`Invalid routes: ${e.message}`); process.exit(1)
}
for (const route of routes.values()) {
  route.endpoint = endpointOf(route.url, route.agentId)
  // Namespaced by agent so re-pointing a chat at another agent starts a fresh conversation
  route.client = createAgentClient({ ...clientOptions, endpoint: route.endpoint, token: route.token, namespace: `${route.agentId}|` })
}

const mediaOptions = {
  allowedKinds: new Set(MEDIA_TYPES.split(',').map(s => s.trim()).filter(Boolean)),
  maxBytes: Number(MAX_MEDIA_MB) * 1024 * 1024,
  logger,
}

// Serialize messages per chat so turns don't race on the same contextId
const queues = new Map()
const enqueue = (jid, fn) => {
  const next = (queues.get(jid) || Promise.resolve()).then(fn).catch(err => console.error(jid, err))
  queues.set(jid, next)
  return next
}

// Chats and group members may be addressed by LID (@lid) instead of phone number; resolve to the phone number when possible
async function resolveNumber(sock, ...jids) {
  const pn = jids.find(j => j?.endsWith('@s.whatsapp.net'))
  if (pn) return userOf(pn)
  const lid = jids.find(j => j?.endsWith('@lid'))
  if (lid) {
    const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(lid).catch(() => null)
    if (mapped) return userOf(mapped)
  }
  const any = jids.find(Boolean)
  return any ? userOf(any) : null
}

// Group names for recorded messages, refreshed at most every 10 minutes
const groupNames = new Map()
async function groupName(sock, jid) {
  const hit = groupNames.get(jid)
  if (hit && Date.now() - hit.at < 600_000) return hit.name
  const name = await sock.groupMetadata(jid).then(m => m.subject).catch(() => hit?.name ?? null)
  groupNames.set(jid, { name, at: Date.now() })
  return name
}

const record = fields => { if (RECORD) report(messageRecord(fields)) }

// Sends a text and records it. The ID is chosen up front so WhatsApp's echo of it is recognised.
async function sendText(sock, jid, text, { quoted, kind = 'system', chat } = {}) {
  const messageId = generateMessageIDV2(sock.user?.id)
  sentIds.add(messageId)
  const sent = await sock.sendMessage(jid, { text }, { quoted, messageId })
  record({ jid, direction: 'out', kind, text, waId: sent?.key?.id ?? messageId, chat })
  return sent
}

const msgTime = msg => (Number(msg.messageTimestamp) ? Number(msg.messageTimestamp) * 1000 : Date.now())

// Log each unmapped group once, with its name, so its JID can be copied into the routes file
const reportedGroups = new Set()
async function reportUnmappedGroup(sock, jid) {
  if (reportedGroups.has(jid)) return
  reportedGroups.add(jid)
  const subject = await sock.groupMetadata(jid).then(m => m.subject).catch(() => null)
  console.log(`unmapped group ${jid}${subject ? ` "${subject}"` : ''}: add it to ${ROUTES_FILE} to connect an agent`)
}

async function handleMessage(sock, msg, info, { agent, from, chat }) {
  const jid = msg.key.remoteJid
  // A human was asked to take over: keep recording, but let them answer
  const pausedUntil = pauses.until(jid)
  if (pausedUntil) return console.log(`${jid}: bot paused for human follow-up until ${new Date(pausedUntil).toISOString()}, not forwarding`)
  if (info.text?.trim() === '/reset' && !info.media) {
    agent.reset(jid)
    return sendText(sock, jid, 'Conversation reset.', { quoted: msg, chat })
  }

  await sock.sendPresenceUpdate('composing', jid)
  let reply
  // agent when the message carries the agent's answer, system for bridge notices and errors
  let replyKind = 'system'
  try {
    let { parts, notice: mediaNotice } = await buildParts(sock, msg, info, { ...mediaOptions, inlineFiles: agent.inlineFiles })
    // Groups share one conversation, so tell the agent who is speaking
    if (from && parts[0]?.text !== undefined) parts[0] = { ...parts[0], text: `[${from}]: ${parts[0].text}` }
    if (HANDOFF) parts = withChatRef(parts, chat.ref)
    if (!parts.length) {
      reply = mediaNotice
    } else {
      const started = Date.now()
      console.log(`${jid}: asking agent`)
      const { answer, notice } = await agent.ask(jid, parts)
      console.log(`${jid}: agent replied in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      reply = [mediaNotice, notice, answer].filter(Boolean).join('\n\n')
      replyKind = 'agent'
    }
  } catch (e) {
    console.error(`${jid}: agent call failed:`, e.message)
    reply = `Agent error: ${e.message}`
  }
  await sock.sendPresenceUpdate('paused', jid)
  if (reply) await sendText(sock, jid, reply, { quoted: msg, kind: replyKind, chat })
}

async function onGroupMessage(sock, msg, info) {
  const jid = msg.key.remoteJid
  const route = routes.get(jid)
  const me = botIds(sock.user)
  // Passive by default: only messages that @mention the bot are handled
  const addressed = route?.trigger === 'all' || isMentioned(info.mentions, me)
  if (!route) reportUnmappedGroup(sock, jid)
  // Messages not meant for the bot only matter when they are recorded
  if (!addressed && !(route && RECORD)) return

  const text = stripMentions(info.text, me)
  if (!route) {
    if (text === '/chatid' && !info.media) return sock.sendMessage(jid, { text: `This group's ID is ${jid}` }, { quoted: msg })
    return console.log(`${jid}: mentioned in an unmapped group, ignoring`)
  }

  // Routed groups: every message is recorded, whether or not the bot handles it
  const number = await resolveNumber(sock, msg.key.participantAlt, msg.key.participant)
  const allowed = !route.allowedNumbers || route.allowedNumbers.has(number)
  const handled = addressed && allowed && Boolean(text || info.media)
  const chat = { ref: chatRefs.get(jid), name: await groupName(sock, jid) }
  record({ jid, direction: 'in', kind: handled ? 'user' : 'ambient', text: info.text, media: info.media, sender: number,
    senderName: msg.pushName || null, waId: msg.key.id, at: msgTime(msg), chat })
  if (!handled) {
    if (addressed && !allowed) console.log(`${jid}: dropped, sender ${number} is not in allowedNumbers for route "${route.name}"`)
    return
  }
  if (text === '/chatid' && !info.media) return sendText(sock, jid, `This group's ID is ${jid}`, { quoted: msg, chat })

  console.log(`${jid}: message from ${number} -> ${route.name}`)
  report({ type: 'activity', at: Date.now() })
  const from = msg.pushName ? `${msg.pushName} (${number})` : number
  enqueue(jid, () => handleMessage(sock, msg, { ...info, text }, { agent: route.client, from, chat }))
}

async function onDirectMessage(sock, msg, info) {
  const jid = msg.key.remoteJid
  const number = await resolveNumber(sock, msg.key.remoteJidAlt, msg.key.senderPn, jid)
  const route = routes.get(number)

  // Allowlist: every message spends your Archestra token, so gate who can reach the agent.
  // A route for this number counts as allowing it. Dropped senders are not recorded.
  if (!route && ALLOWED.size && !ALLOWED.has(number)) {
    return console.log(`${jid}: dropped, sender ${number} is not in ALLOWED_NUMBERS`)
  }
  const chat = { ref: chatRefs.get(jid), name: msg.pushName || null, phone: number }
  record({ jid, direction: 'in', kind: 'user', text: info.text, media: info.media, sender: number, senderName: msg.pushName || null,
    waId: msg.key.id, at: msgTime(msg), chat })
  if (info.text?.trim() === '/chatid' && !info.media) {
    return sendText(sock, jid, `Your route key is ${number}`, { quoted: msg, chat })
  }

  console.log(`${jid}: message from ${number}${route ? ` -> ${route.name}` : ''}`)
  report({ type: 'activity', at: Date.now() })
  enqueue(jid, () => handleMessage(sock, msg, info, { agent: route?.client || defaultAgent, chat }))
}

// Messages someone typed on the linked phone (or another linked device), as opposed to ones the
// bridge sent. Recorded as "human" so the export shows the whole conversation.
const OWN_MESSAGE_MAX_AGE_MS = 5 * 60_000
async function recordOwnMessage(sock, msg) {
  const jid = msg.key.remoteJid
  if (!RECORD || sentIds.has(msg.key.id) || Date.now() - msgTime(msg) > OWN_MESSAGE_MAX_AGE_MS) return
  const isGroup = jid.endsWith('@g.us')
  if (isGroup && !routes.has(jid)) return
  const info = inspectMessage(msg)
  if (!info.text && !info.media) return
  sentIds.add(msg.key.id)
  const chat = isGroup
    ? { ref: chatRefs.get(jid), name: await groupName(sock, jid) }
    : { ref: chatRefs.get(jid), phone: await resolveNumber(sock, msg.key.remoteJidAlt, jid) }
  record({ jid, direction: 'out', kind: 'human', text: info.text, media: info.media, sender: userOf(sock.user?.id ?? ''),
    senderName: sock.user?.name ?? null, waId: msg.key.id, at: msgTime(msg), chat })
}

// Current socket, for commands from the runner
let current = null
let isOpen = false
let attempt = 0

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({ auth: state, logger })
  current = sock

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // scan with WhatsApp > Linked devices
      if (MANAGED) report({ type: 'qr', qr })
      else qrcode.generate(qr, { small: true })
    }
    if (connection === 'connecting') report({ type: 'status', state: 'connecting' })
    if (connection === 'open') {
      attempt = 0
      isOpen = true
      report({ type: 'status', state: 'connected', phone: userOf(sock.user?.id ?? ''), pushName: sock.user?.name ?? null })
      console.log('WhatsApp connected, forwarding direct chats to', A2A_ENDPOINT)
      for (const r of routes.values()) console.log(`  route ${r.isGroup ? 'group' : 'number'} ${r.key} (${r.name}) -> ${r.endpoint}${r.isGroup ? ` [${r.trigger}]` : ''}`)
    }
    if (connection === 'close') {
      isOpen = false
      if (current === sock) current = null
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut
      if (loggedOut) {
        console.error(`Logged out: delete ${AUTH_DIR} and re-pair`)
        report({ type: 'status', state: 'logged_out' })
        // Exit code 3 tells the runner not to restart until the session is re-paired
        if (MANAGED) process.exit(3)
        return
      }
      // Back off between reconnects so a flapping session doesn't hammer WhatsApp
      const delay = reconnectDelay(attempt++)
      report({ type: 'status', state: 'reconnecting', detail: lastDisconnect?.error?.message ?? null })
      console.log(`Connection closed (${lastDisconnect?.error?.message ?? 'unknown'}), reconnecting in ${(delay / 1000).toFixed(1)}s`)
      setTimeout(start, delay)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (!jid || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue
      if (msg.key.fromMe) {
        await recordOwnMessage(sock, msg).catch(err => console.error(`${jid}: failed to record own message:`, err.message))
        continue
      }
      if (type !== 'notify') continue // skip history sync

      const info = inspectMessage(msg)
      if (!info.text && !info.media) continue

      try {
        if (jid.endsWith('@g.us')) await onGroupMessage(sock, msg, info)
        else await onDirectMessage(sock, msg, info)
      } catch (err) {
        console.error(`${jid}: failed to handle message:`, err.message)
      }
    }
  })
}

// Requests from the runner: { type: 'request', id, action, args } -> { type: 'response', id, ok, result | error }
async function runCommand(action, args = {}) {
  // Pausing works even while WhatsApp is reconnecting
  if (action === 'pause') {
    if (!args.jid) throw new Error('jid is required')
    const minutes = Number(args.minutes)
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number')
    return { pausedUntil: pauses.pause(args.jid, minutes) }
  }
  if (action === 'resume') {
    if (!args.jid) throw new Error('jid is required')
    pauses.resume(args.jid)
    return { pausedUntil: null }
  }
  const sock = current
  if (!sock) throw new Error('WhatsApp is not connected yet')
  if (action === 'pairingCode') {
    if (sock.authState.creds.registered) throw new Error('This number is already linked')
    const phone = String(args.phone || '').replace(/\D/g, '')
    if (!phone) throw new Error('phone is required (country code, digits only)')
    return { code: await sock.requestPairingCode(phone) }
  }
  // Anything else needs a linked, open session; Baileys would otherwise wait until it times out
  if (!isOpen) throw new Error('This number is not linked to WhatsApp yet')
  if (action === 'groups') {
    const groups = await sock.groupFetchAllParticipating()
    return Object.values(groups)
      .map(g => ({ jid: g.id, subject: g.subject, size: g.participants?.length ?? null }))
      .sort((a, b) => String(a.subject).localeCompare(String(b.subject)))
  }
  if (action === 'handoff') return handoff(sock, args)
  if (action === 'logout') {
    await sock.logout()
    return { ok: true }
  }
  throw new Error(`unknown action ${action}`)
}

// Alert human agents about a chat, then pause the bot there so they can take over
async function handoff(sock, { jid, recipients = [], text, pauseMinutes = 0 }) {
  if (!jid || !text || !Array.isArray(recipients) || !recipients.length) throw new Error('jid, text and recipients are required')
  const results = []
  for (const raw of recipients.slice(0, 50)) {
    const phone = String(raw).replace(/\D/g, '')
    try {
      const [found] = await sock.onWhatsApp(phone)
      if (!found?.exists) { results.push({ phone, ok: false, error: 'not on WhatsApp' }); continue }
      await sendText(sock, found.jid, text, { kind: 'handoff', chat: { phone } })
      results.push({ phone, ok: true })
    } catch (e) {
      results.push({ phone, ok: false, error: e.message })
    }
  }
  const alerted = results.filter(r => r.ok).length
  const pausedUntil = alerted && pauseMinutes > 0 ? pauses.pause(jid, Number(pauseMinutes)) : null
  console.log(`${jid}: human follow-up requested, alerted ${alerted} of ${results.length}${pausedUntil ? `, bot paused until ${new Date(pausedUntil).toISOString()}` : ''}`)
  return { results, pausedUntil }
}

if (MANAGED) {
  process.on('message', async msg => {
    if (msg?.type !== 'request') return
    try {
      report({ type: 'response', id: msg.id, ok: true, result: await runCommand(msg.action, msg.args) })
    } catch (e) {
      report({ type: 'response', id: msg.id, ok: false, error: e.message })
    }
  })
  // The runner went away: don't keep a WhatsApp session running unsupervised
  process.on('disconnect', () => process.exit(0))
}

start()
