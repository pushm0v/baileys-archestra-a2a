// WhatsApp (Baileys) -> Archestra agent bridge over the A2A v2 protocol.
// Config comes from environment variables; see .env.example.

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const {
  ARCHESTRA_URL,
  ARCHESTRA_AGENT_ID,
  ARCHESTRA_TOKEN,
  DATA_DIR = './data',
  AGENT_TIMEOUT_MS = String(5 * 60_000),
  LOG_LEVEL = 'warn',
} = process.env

for (const [k, v] of Object.entries({ ARCHESTRA_URL, ARCHESTRA_AGENT_ID, ARCHESTRA_TOKEN })) {
  if (!v) { console.error(`Missing required env var ${k}`); process.exit(1) }
}

const ALLOWED = new Set((process.env.ALLOWED_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean))
if (!ALLOWED.size) console.warn('ALLOWED_NUMBERS is empty: anyone who messages this number can reach the agent')

fs.mkdirSync(DATA_DIR, { recursive: true })
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const CTX_FILE = path.join(DATA_DIR, 'contexts.json')
const A2A_ENDPOINT = `${ARCHESTRA_URL.replace(/\/$/, '')}/v2/a2a/${ARCHESTRA_AGENT_ID}`

// chat JID -> Archestra contextId (Archestra generates it; we must remember it per chat)
const contexts = fs.existsSync(CTX_FILE) ? JSON.parse(fs.readFileSync(CTX_FILE, 'utf8')) : {}
const saveContexts = () => fs.writeFileSync(CTX_FILE, JSON.stringify(contexts, null, 2))

// Serialize messages per chat so turns don't race on the same contextId
const queues = new Map()
const enqueue = (jid, fn) => {
  const next = (queues.get(jid) || Promise.resolve()).then(fn).catch(err => console.error(jid, err))
  queues.set(jid, next)
  return next
}

async function askAgent(jid, text) {
  const message = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] }
  if (contexts[jid]) message.contextId = contexts[jid]

  const res = await fetch(A2A_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ARCHESTRA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'SendMessage', params: { message } }),
    signal: AbortSignal.timeout(Number(AGENT_TIMEOUT_MS)), // agent runs synchronously; tool-heavy runs can be slow
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = await res.json()
  if (body.error) throw new Error(JSON.stringify(body.error))

  const { message: reply, task } = body.result || {}
  const ctx = reply?.contextId || task?.contextId
  if (ctx && ctx !== contexts[jid]) { contexts[jid] = ctx; saveContexts() }

  if (task) return 'This request needs approval in Archestra before I can continue.'
  return (reply?.parts || []).map(p => p.text).filter(Boolean).join('\n') || '(no text reply)'
}

function extractText(msg) {
  const m = msg.message
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || null
}

// Chats may be addressed by LID (@lid) instead of phone number; prefer the phone-number alias when present
function senderNumber(key) {
  const pn = [key.remoteJidAlt, key.senderPn, key.remoteJid].find(j => j?.endsWith('@s.whatsapp.net'))
  return (pn || key.remoteJid).split('@')[0]
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({ auth: state, logger: pino({ level: LOG_LEVEL }) })

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

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return // skip history sync
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (msg.key.fromMe || !jid || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue

      const text = extractText(msg)
      if (!text) continue

      // Allowlist: every message spends your Archestra token, so gate who can reach the agent
      if (ALLOWED.size && !ALLOWED.has(senderNumber(msg.key))) continue

      enqueue(jid, async () => {
        if (text.trim() === '/reset') {
          delete contexts[jid]; saveContexts()
          return sock.sendMessage(jid, { text: 'Conversation reset.' })
        }
        await sock.sendPresenceUpdate('composing', jid)
        const answer = await askAgent(jid, text).catch(e => `Agent error: ${e.message}`)
        await sock.sendPresenceUpdate('paused', jid)
        await sock.sendMessage(jid, { text: answer }, { quoted: msg })
      })
    }
  })
}

start()
