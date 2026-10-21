import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bridgeEnv, ConfigError } from '../src/runner/config.mjs'
import { Supervisor } from '../src/runner/supervisor.mjs'
import { reconnectDelay } from '../src/backoff.mjs'

const env = { ARCHESTRA_URL: 'http://a:9000', ARCHESTRA_TOKEN: 'default-tok', SALES_TOKEN: 'sales-tok', RUNNER_TOKEN: 'secret', DASHBOARD_URL: 'https://d' }
const number = { id: 'n1', name: 'support', enabled: true, agentId: 'agent-1', allowedNumbers: ['6281'], routes: {} }

test('bridgeEnv fills defaults from the runner and hides runner credentials', () => {
  const out = bridgeEnv(number, env, '/data/instances')
  assert.equal(out.ARCHESTRA_URL, 'http://a:9000')
  assert.equal(out.ARCHESTRA_TOKEN, 'default-tok')
  assert.equal(out.ARCHESTRA_AGENT_ID, 'agent-1')
  assert.equal(out.ALLOWED_NUMBERS, '6281')
  assert.equal(out.DATA_DIR, path.join('/data/instances', 'n1'))
  assert.equal(out.RUNNER_TOKEN, undefined)
  assert.equal(out.DASHBOARD_URL, undefined)
})

test('bridgeEnv resolves token references to env vars on the runner', () => {
  const out = bridgeEnv({ ...number, tokenRef: 'SALES_TOKEN', routes: { '1203@g.us': { agentId: 'x', tokenRef: 'SALES_TOKEN' } } }, env, '/d')
  assert.equal(out.ARCHESTRA_TOKEN, 'sales-tok')
  assert.deepEqual(JSON.parse(out.ROUTES_JSON), { '1203@g.us': { agentId: 'x', token: 'env:SALES_TOKEN' } })
})

test('bridgeEnv reports missing tokens and bad ids as config errors', () => {
  assert.throws(() => bridgeEnv({ ...number, tokenRef: 'NOPE' }, env, '/d'), ConfigError)
  assert.throws(() => bridgeEnv({ ...number, routes: { k: { agentId: 'x', tokenRef: 'NOPE' } } }, env, '/d'), /NOPE is not set/)
  assert.throws(() => bridgeEnv({ ...number, id: '../etc' }, env, '/d'), /invalid number id/)
})

test('reconnectDelay grows, is capped, and keeps jitter within half to full', () => {
  assert.equal(reconnectDelay(0, { random: () => 0 }), 500)
  assert.equal(reconnectDelay(0, { random: () => 1 }), 1000)
  assert.equal(reconnectDelay(3, { random: () => 1 }), 8000)
  assert.equal(reconnectDelay(50, { random: () => 1, max: 60_000 }), 60_000)
})

// Fake child process: records messages, exits on kill
function fakeFork(log) {
  return (entry, args, opts) => {
    const child = new EventEmitter()
    child.connected = true
    child.env = opts.env
    child.sent = []
    child.send = m => {
      child.sent.push(m)
      if (m.type === 'request') setImmediate(() => child.emit('message', { type: 'response', id: m.id, ok: true, result: { echoed: m.action } }))
    }
    child.kill = () => setImmediate(() => { child.connected = false; child.emit('exit', 0) })
    log.push(child)
    return child
  }
}

function setup() {
  const children = []
  const events = []
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'))
  const sup = new Supervisor({ entry: 'bridge.mjs', dataRoot, cacheFile: path.join(dataRoot, 'cache.json'), env, emit: e => events.push(e), forkFn: fakeFork(children) })
  return { sup, children, events, dataRoot }
}

test('supervisor starts, restarts on change, and stops removed numbers', async () => {
  const { sup, children, events, dataRoot } = setup()
  await sup.sync([number])
  assert.equal(children.length, 1)
  assert.equal(children[0].env.ARCHESTRA_AGENT_ID, 'agent-1')

  await sup.sync([number]) // unchanged: no restart
  assert.equal(children.length, 1)

  await sup.sync([{ ...number, agentId: 'agent-2' }])
  assert.equal(children.length, 2)
  assert.equal(children[1].env.ARCHESTRA_AGENT_ID, 'agent-2')

  await sup.sync([])
  assert.equal(sup.instances.size, 0)
  assert.ok(events.some(e => e.type === 'removed' && e.numberId === 'n1'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, 'cache.json'), 'utf8')), [])
})

test('supervisor reports config errors instead of starting', async () => {
  const { sup, children, events } = setup()
  await sup.sync([{ ...number, tokenRef: 'MISSING' }])
  assert.equal(children.length, 0)
  const last = events.filter(e => e.type === 'status').at(-1)
  assert.equal(last.state, 'error')
  assert.match(last.detail, /MISSING is not set/)
})

test('supervisor forwards requests to the bridge process and tracks status', async () => {
  const { sup, children, events } = setup()
  await sup.sync([number])
  children[0].emit('message', { type: 'qr', qr: 'QRDATA' })
  assert.ok(events.some(e => e.type === 'qr' && e.qr === 'QRDATA'))
  children[0].emit('message', { type: 'status', state: 'connected', phone: '6281' })
  assert.equal(sup.statuses()[0].state, 'connected')
  assert.equal(sup.statuses()[0].phone, '6281')
  assert.deepEqual(await sup.handle('n1', 'groups'), { echoed: 'groups' })
  await assert.rejects(sup.handle('other', 'groups'), /not assigned/)
})

test('a logged-out bridge is not restarted until it is re-paired', async () => {
  const { sup, children, dataRoot } = setup()
  await sup.sync([number])
  fs.mkdirSync(path.join(dataRoot, 'n1', 'auth'), { recursive: true })
  children[0].connected = false
  children[0].emit('exit', 3)
  assert.equal(sup.statuses()[0].state, 'logged_out')

  await sup.sync([number]) // same settings: stays logged out
  assert.equal(children.length, 1)

  await sup.handle('n1', 'unlink')
  assert.equal(children.length, 2)
  assert.equal(fs.existsSync(path.join(dataRoot, 'n1', 'auth')), false)
})

test('disabling a number stops it', async () => {
  const { sup, children } = setup()
  await sup.sync([number])
  await sup.sync([{ ...number, enabled: false }])
  assert.equal(children[0].connected, false)
  assert.equal(sup.statuses()[0].state, 'stopped')
})
