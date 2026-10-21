// WhatsApp (Baileys) -> Archestra agent bridge over the A2A v2 protocol.
// Config comes from environment variables; see .env.example.

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import { inspectMessage, buildParts } from './media.mjs'
import { createAgentClient, createContextStore } from './agent.mjs'
import { loadRoutes, parseRoutes, botIds, isMentioned, stripMentions, userOf } from './routes.mjs'
import { reconnectDelay } from './backoff.mjs'

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
  report({ type: 'activity', at: Date.now() })
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
  report({ type: 'activity', at: Date.now() })
  enqueue(jid, () => handleMessage(sock, msg, info, { agent: route?.client || defaultAgent }))
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

// Requests from the runner: { type: 'request', id, action, args } -> { type: 'response', id, ok, result | error }
async function runCommand(action, args = {}) {
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
  if (action === 'logout') {
    await sock.logout()
    return { ok: true }
  }
  throw new Error(`unknown action ${action}`)
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
