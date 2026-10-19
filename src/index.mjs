// WhatsApp (Baileys) -> Archestra agent bridge over the A2A v2 protocol.
// Config comes from environment variables; see .env.example.

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import { inspectMessage, buildParts } from './media.mjs'
import { createAgentClient, createContextStore } from './agent.mjs'
import { loadRoutes, botIds, isMentioned, stripMentions, userOf } from './routes.mjs'

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
const clientOptions = { store: contexts, timeoutMs: Number(AGENT_TIMEOUT_MS), mediaInline: MEDIA_INLINE, logger: console }

// Default agent: direct chats without their own route
const defaultAgent = createAgentClient({ ...clientOptions, endpoint: A2A_ENDPOINT, token: ARCHESTRA_TOKEN })

let routes
try {
  routes = loadRoutes(ROUTES_FILE, { url: ARCHESTRA_URL, token: ARCHESTRA_TOKEN, env: process.env })
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

// Log each unmapped group once, with its name, so its JID can be copied into the routes file
const reportedGroups = new Set()
async function reportUnmappedGroup(sock, jid) {
  if (reportedGroups.has(jid)) return
  reportedGroups.add(jid)
  const subject = await sock.groupMetadata(jid).then(m => m.subject).catch(() => null)
  console.log(`unmapped group ${jid}${subject ? ` "${subject}"` : ''}: add it to ${ROUTES_FILE} to connect an agent`)
}

async function handleMessage(sock, msg, info, { agent, from }) {
  const jid = msg.key.remoteJid
  if (info.text?.trim() === '/reset' && !info.media) {
    agent.reset(jid)
    return sock.sendMessage(jid, { text: 'Conversation reset.' }, { quoted: msg })
  }

  await sock.sendPresenceUpdate('composing', jid)
  let reply
  try {
    const { parts, notice: mediaNotice } = await buildParts(sock, msg, info, { ...mediaOptions, inlineFiles: agent.inlineFiles })
    // Groups share one conversation, so tell the agent who is speaking
    if (from && parts[0]?.text !== undefined) parts[0] = { ...parts[0], text: `[${from}]: ${parts[0].text}` }
    if (!parts.length) {
      reply = mediaNotice
    } else {
      const started = Date.now()
      console.log(`${jid}: asking agent`)
      const { answer, notice } = await agent.ask(jid, parts)
      console.log(`${jid}: agent replied in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      reply = [mediaNotice, notice, answer].filter(Boolean).join('\n\n')
    }
  } catch (e) {
    console.error(`${jid}: agent call failed:`, e.message)
    reply = `Agent error: ${e.message}`
  }
  await sock.sendPresenceUpdate('paused', jid)
  if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: msg })
}

async function onGroupMessage(sock, msg, info) {
  const jid = msg.key.remoteJid
  const route = routes.get(jid)
  const me = botIds(sock.user)
  // Passive by default: only messages that @mention the bot are handled
  const addressed = route?.trigger === 'all' || isMentioned(info.mentions, me)
  if (!route) reportUnmappedGroup(sock, jid)
  if (!addressed) return

  const text = stripMentions(info.text, me)
  if (text === '/chatid' && !info.media) {
    return sock.sendMessage(jid, { text: `This group's ID is ${jid}` }, { quoted: msg })
  }
  if (!route) return console.log(`${jid}: mentioned in an unmapped group, ignoring`)
  if (!text && !info.media) return

  const number = await resolveNumber(sock, msg.key.participantAlt, msg.key.participant)
  if (route.allowedNumbers && !route.allowedNumbers.has(number)) {
    return console.log(`${jid}: dropped, sender ${number} is not in allowedNumbers for route "${route.name}"`)
  }

  console.log(`${jid}: message from ${number} -> ${route.name}`)
  const from = msg.pushName ? `${msg.pushName} (${number})` : number
  enqueue(jid, () => handleMessage(sock, msg, { ...info, text }, { agent: route.client, from }))
}

async function onDirectMessage(sock, msg, info) {
  const jid = msg.key.remoteJid
  const number = await resolveNumber(sock, msg.key.remoteJidAlt, msg.key.senderPn, jid)
  const route = routes.get(number)

  // Allowlist: every message spends your Archestra token, so gate who can reach the agent.
  // A route for this number counts as allowing it.
  if (!route && ALLOWED.size && !ALLOWED.has(number)) {
    return console.log(`${jid}: dropped, sender ${number} is not in ALLOWED_NUMBERS`)
  }
  if (info.text?.trim() === '/chatid' && !info.media) {
    return sock.sendMessage(jid, { text: `Your route key is ${number}` }, { quoted: msg })
  }

  console.log(`${jid}: message from ${number}${route ? ` -> ${route.name}` : ''}`)
  enqueue(jid, () => handleMessage(sock, msg, info, { agent: route?.client || defaultAgent }))
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({ auth: state, logger })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true }) // scan with WhatsApp > Linked devices
    if (connection === 'open') {
      console.log('WhatsApp connected, forwarding direct chats to', A2A_ENDPOINT)
      for (const r of routes.values()) console.log(`  route ${r.isGroup ? 'group' : 'number'} ${r.key} (${r.name}) -> ${r.endpoint}${r.isGroup ? ` [${r.trigger}]` : ''}`)
    }
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut
      if (!loggedOut) start()
      else console.error(`Logged out: delete ${AUTH_DIR} and re-pair`)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return // skip history sync
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (msg.key.fromMe || !jid || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue

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

start()
