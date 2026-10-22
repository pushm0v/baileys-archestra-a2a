// Runner: runs one bridge process per WhatsApp number, as configured in the dashboard.
// It dials out to the dashboard over a WebSocket, so the host needs no open ports.
//
//   DASHBOARD_URL  https://whatsapp-dashboard.example.workers.dev
//   RUNNER_TOKEN   token shown when the runner was added in the dashboard
//   DATA_DIR       sessions live in $DATA_DIR/instances/<number id>
//   ARCHESTRA_URL / ARCHESTRA_TOKEN  defaults for numbers that don't set their own
//   any other env var can hold a token that a number or route refers to by name

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import QRCode from 'qrcode'
import { Supervisor } from './runner/supervisor.mjs'
import { reconnectDelay } from './backoff.mjs'

const { DASHBOARD_URL, RUNNER_TOKEN, DATA_DIR = './data' } = process.env
for (const [k, v] of Object.entries({ DASHBOARD_URL, RUNNER_TOKEN })) {
  if (!v) { console.error(`Missing required env var ${k}`); process.exit(1) }
}

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const PING_MS = 30_000
const DEAD_AFTER_MS = 90_000
const ACTIVITY_THROTTLE_MS = 5_000

const dataRoot = path.join(DATA_DIR, 'instances')
const connectUrl = `${DASHBOARD_URL.replace(/\/$/, '').replace(/^http/, 'ws')}/runner/connect`

let ws = null
const send = msg => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }

// Coalesce message activity so a busy chat doesn't flood the dashboard
const activity = new Map()
function sendActivity(numberId, at) {
  const a = activity.get(numberId) ?? { count: 0, timer: null, at }
  a.count++
  a.at = at
  activity.set(numberId, a)
  if (a.timer) return
  a.timer = setTimeout(() => {
    activity.delete(numberId)
    send({ type: 'activity', numberId, at: a.at, count: a.count })
  }, ACTIVITY_THROTTLE_MS)
}

async function onEvent(event) {
  const name = supervisor.instances.get(event.numberId)?.config?.name || event.numberId
  if (event.type === 'log') {
    ;(event.stream === 'stderr' ? console.error : console.log)(`[${name}] ${event.line}`)
    return send(event)
  }
  if (event.type === 'status') console.log(`[${name}] ${event.state}${event.detail ? `: ${event.detail}` : ''}`)
  if (event.type === 'activity') return sendActivity(event.numberId, event.at)
  if (event.type === 'qr') {
    // Render here so the dashboard only shows an image; the raw pairing string never leaves the runner
    const svg = event.qr ? await QRCode.toString(event.qr, { type: 'svg', margin: 1 }) : null
    if (event.qr) console.log(`[${name}] QR code ready: open the dashboard to scan it`)
    return send({ type: 'qr', numberId: event.numberId, svg })
  }
  send(event)
}

const supervisor = new Supervisor({
  entry: fileURLToPath(new URL('./index.mjs', import.meta.url)),
  dataRoot,
  cacheFile: path.join(dataRoot, 'runner-config.json'),
  env: process.env,
  emit: e => onEvent(e).catch(err => console.error('event failed:', err.message)),
})

async function onMessage(raw) {
  if (raw === 'pong') return
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  if (msg.type === 'sync') {
    console.log(`dashboard sent settings for ${msg.numbers.length} number(s)`)
    await supervisor.sync(msg.numbers)
  } else if (msg.type === 'request') {
    const name = supervisor.instances.get(msg.numberId)?.config?.name || msg.numberId
    const started = Date.now()
    const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
    console.log(`[${name}] dashboard asked for ${msg.action}`)
    try {
      const result = await supervisor.handle(msg.numberId, msg.action, msg.args)
      console.log(`[${name}] ${msg.action} done in ${took()}${Array.isArray(result) ? ` (${result.length} items)` : ''}`)
      send({ type: 'response', id: msg.id, ok: true, result })
    } catch (e) {
      console.error(`[${name}] ${msg.action} failed after ${took()}: ${e.message}`)
      send({ type: 'response', id: msg.id, ok: false, error: e.message })
    }
  }
}

let attempt = 0
function connect() {
  const socket = new WebSocket(connectUrl, { headers: { Authorization: `Bearer ${RUNNER_TOKEN}` } })
  ws = socket
  let lastSeen = Date.now()
  let pinger = null

  socket.on('open', () => {
    attempt = 0
    console.log(`connected to dashboard ${DASHBOARD_URL}`)
    socket.send(JSON.stringify({ type: 'hello', version: VERSION, statuses: supervisor.statuses() }))
    // Plain "ping" text gets an automatic "pong" from the dashboard without waking it up
    pinger = setInterval(() => {
      if (Date.now() - lastSeen > DEAD_AFTER_MS) {
        console.log(`no reply from the dashboard for ${DEAD_AFTER_MS / 1000}s, reconnecting`)
        return socket.terminate()
      }
      socket.send('ping')
    }, PING_MS)
  })
  socket.on('message', data => {
    lastSeen = Date.now()
    onMessage(data.toString()).catch(e => console.error('dashboard message failed:', e.message))
  })
  socket.on('unexpected-response', (_req, res) => {
    console.error(`dashboard refused the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (check RUNNER_TOKEN)' : ''}`)
  })
  socket.on('error', err => console.error('dashboard connection error:', err.message))
  socket.on('close', (code, reason) => {
    clearInterval(pinger)
    if (ws === socket) ws = null
    const delay = reconnectDelay(attempt++, { max: 60_000 })
    const why = `code ${code}${reason?.length ? `: ${reason}` : ''}`
    console.log(`dashboard connection closed (${why}), retrying in ${(delay / 1000).toFixed(1)}s (numbers keep running)`)
    setTimeout(connect, delay)
  })
}

// Start from the last known settings, so a dashboard outage doesn't take numbers down
const cached = supervisor.loadCache()
if (cached) {
  console.log(`starting ${cached.length} number(s) from cached settings`)
  supervisor.sync(cached)
}
connect()

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`${sig}: stopping numbers`)
    await supervisor.stopAll()
    process.exit(0)
  })
}
