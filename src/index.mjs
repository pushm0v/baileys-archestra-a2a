// WhatsApp (Baileys) -> Archestra agent bridge over the A2A v2 protocol.
// Config comes from environment variables; see .env.example.

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'
import { inspectMessage, buildParts } from './media.mjs'
import { createAgentClient } from './agent.mjs'

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
const A2A_ENDPOINT = `${ARCHESTRA_URL.replace(/\/$/, '')}/v2/a2a/${ARCHESTRA_AGENT_ID}`

const agent = createAgentClient({
  endpoint: A2A_ENDPOINT,
  token: ARCHESTRA_TOKEN,
  contextFile: path.join(DATA_DIR, 'contexts.json'),
  timeoutMs: Number(AGENT_TIMEOUT_MS),
  mediaInline: MEDIA_INLINE,
  logger: console,
})

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

// Chats may be addressed by LID (@lid) instead of phone number; resolve to the phone number when possible
const userOf = jid => jid.split('@')[0].split(':')[0]
async function senderNumber(sock, key) {
  const pn = [key.remoteJidAlt, key.senderPn, key.remoteJid].find(j => j?.endsWith('@s.whatsapp.net'))
  if (pn) return userOf(pn)
  if (key.remoteJid?.endsWith('@lid')) {
    const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(key.remoteJid).catch(() => null)
    if (mapped) return userOf(mapped)
  }
  return userOf(key.remoteJid)
}

async function handleMessage(sock, msg, info) {
  const jid = msg.key.remoteJid
  if (info.text?.trim() === '/reset' && !info.media) {
    agent.reset(jid)
    return sock.sendMessage(jid, { text: 'Conversation reset.' })
  }

  await sock.sendPresenceUpdate('composing', jid)
  let reply
  try {
    const { parts, notice: mediaNotice } = await buildParts(sock, msg, info, { ...mediaOptions, inlineFiles: agent.inlineFiles })
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({ auth: state, logger })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true }) // scan with WhatsApp > Linked devices
    if (connection === 'open') console.log('WhatsApp connected, forwarding to', A2A_ENDPOINT)
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
      if (msg.key.fromMe || !jid || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue

      const info = inspectMessage(msg)
      if (!info.text && !info.media) { console.log(`${jid}: ignored message with no text or supported media`); continue }

      // Allowlist: every message spends your Archestra token, so gate who can reach the agent
      const number = await senderNumber(sock, msg.key)
      if (ALLOWED.size && !ALLOWED.has(number)) {
        console.log(`${jid}: dropped, sender ${number} is not in ALLOWED_NUMBERS`)
        continue
      }

      console.log(`${jid}: message from ${number}`)
      enqueue(jid, () => handleMessage(sock, msg, info))
    }
  })
}

start()
