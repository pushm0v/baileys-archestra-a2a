import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatRefs, createPauses, createSentIds, messageRecord, withChatRef } from '../src/chatlog.mjs'
import { Outbox } from '../src/runner/outbox.mjs'
import { bridgeEnv } from '../src/runner/config.mjs'
import { Supervisor } from '../src/runner/supervisor.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'))

test('chat refs are random, stable per chat, and survive a restart', () => {
  const file = path.join(tmp(), 'refs.json')
  const refs = createChatRefs(file)
  const a = refs.get('628111@s.whatsapp.net')
  assert.match(a, /^c[A-Za-z0-9_-]{16}$/)
  assert.equal(refs.get('628111@s.whatsapp.net'), a)
  assert.notEqual(refs.get('1203@g.us'), a)
  assert.equal(createChatRefs(file).get('628111@s.whatsapp.net'), a)
})

test('pauses expire and can be lifted early', () => {
  let now = 1_000_000
  const file = path.join(tmp(), 'paused.json')
  const pauses = createPauses(file, () => now)
  assert.equal(pauses.until('a'), null)
  assert.equal(pauses.pause('a', 10), now + 600_000)
  assert.equal(createPauses(file, () => now).until('a'), now + 600_000)
  now += 600_001
  assert.equal(pauses.until('a'), null)
  pauses.pause('b', 5)
  pauses.resume('b')
  assert.equal(pauses.until('b'), null)
})

test('the chat_ref line goes first, before the group sender prefix and any file', () => {
  assert.deepEqual(withChatRef([{ text: '[Budi (628)]: hi' }], 'cX'), [{ text: '[chat_ref=cX]\n[Budi (628)]: hi' }])
  assert.deepEqual(withChatRef([{ raw: 'AA', mediaType: 'image/png' }], 'cX'), [{ text: '[chat_ref=cX]' }, { raw: 'AA', mediaType: 'image/png' }])
  assert.deepEqual(withChatRef([], 'cX'), [])
})

test('message records carry what the dashboard stores, without file bytes', () => {
  const r = messageRecord({ jid: 'j@s.whatsapp.net', direction: 'in', kind: 'user', text: 'hi', media: { kind: 'image', mediaType: 'image/png', filename: 'a.png', size: 10, voiceNote: false }, chat: { ref: 'cX', phone: '628' } })
  assert.equal(r.type, 'message')
  assert.match(r.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(r.media, { kind: 'image', mediaType: 'image/png', filename: 'a.png', size: 10 })
  assert.deepEqual(r.chat, { ref: 'cX', name: null, phone: '628' })
})

test('sent IDs are remembered up to a limit', () => {
  const ids = createSentIds(2)
  ids.add('a'); ids.add('b'); ids.add('c')
  assert.equal(ids.has('a'), false)
  assert.equal(ids.has('c'), true)
})

function fakeSocket() {
  const sent = []
  let open = false
  return { sent, setOpen: v => { open = v }, send: m => { if (!open) return false; sent.push(m); return true } }
}

test('outbox batches messages and keeps them until acknowledged', async () => {
  const ws = fakeSocket()
  const box = new Outbox({ send: ws.send, batchSize: 2, delayMs: 5, logger: {} })
  for (const n of [1, 2, 3]) box.push({ n })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(ws.sent.length, 0) // not connected yet: nothing lost
  assert.equal(box.size, 3)

  ws.setOpen(true)
  box.connected()
  assert.deepEqual(ws.sent[0].items, [{ n: 1 }, { n: 2 }])
  assert.equal(ws.sent.length, 1) // one batch in flight at a time

  // Connection drops before the ack: the batch is sent again, in order
  box.disconnected()
  box.connected()
  assert.deepEqual(ws.sent[1].items, [{ n: 1 }, { n: 2 }])
  box.ack('stale-batch-id')
  assert.equal(ws.sent.length, 2)
  box.ack(ws.sent[1].batch)
  assert.deepEqual(ws.sent[2].items, [{ n: 3 }])
  box.ack(ws.sent[2].batch)
  assert.equal(box.size, 0)
})

test('outbox resends a batch that was never acknowledged, and drops the oldest when full', async () => {
  const ws = fakeSocket()
  ws.setOpen(true)
  const box = new Outbox({ send: ws.send, delayMs: 1, ackTimeoutMs: 10, max: 3, logger: {} })
  box.push({ n: 1 })
  await new Promise(r => setTimeout(r, 40))
  assert.ok(ws.sent.length >= 2)
  assert.deepEqual(ws.sent[1].items, [{ n: 1 }])

  ws.setOpen(false)
  box.disconnected()
  for (const n of [2, 3, 4, 5]) box.push({ n })
  assert.equal(box.size, 3)
  ws.setOpen(true)
  box.connected()
  assert.deepEqual(ws.sent.at(-1).items, [{ n: 3 }, { n: 4 }, { n: 5 }])
  // Stop the resend timer so the test process can exit
  ws.setOpen(false)
  box.disconnected()
})

const env = { ARCHESTRA_URL: 'http://a:9000', ARCHESTRA_TOKEN: 't' }
const number = { id: 'n1', name: 'support', enabled: true, agentId: 'agent-1', allowedNumbers: [], routes: {} }

test('bridgeEnv passes the recording and handoff switches', () => {
  assert.equal(bridgeEnv(number, env, '/d').RECORD_MESSAGES, '1')
  assert.equal(bridgeEnv(number, env, '/d').HANDOFF_ENABLED, '0')
  const on = bridgeEnv({ ...number, recordMessages: false, handoff: true }, env, '/d')
  assert.equal(on.RECORD_MESSAGES, '0')
  assert.equal(on.HANDOFF_ENABLED, '1')
})

test('supervisor forwards recorded messages and handoff commands', async () => {
  const children = []
  const events = []
  const forkFn = (entry, args, opts) => {
    const child = new EventEmitter()
    child.connected = true
    child.send = m => { if (m.type === 'request') setImmediate(() => child.emit('message', { type: 'response', id: m.id, ok: true, result: { action: m.action, args: m.args } })) }
    child.kill = () => setImmediate(() => { child.connected = false; child.emit('exit', 0) })
    children.push(child)
    return child
  }
  const dataRoot = tmp()
  const sup = new Supervisor({ entry: 'bridge.mjs', dataRoot, env, emit: e => events.push(e), forkFn })
  await sup.sync([number])

  children[0].emit('message', { type: 'message', id: 'm1', jid: 'j@s.whatsapp.net', text: 'hi' })
  assert.deepEqual(events.find(e => e.type === 'message'), { type: 'message', numberId: 'n1', item: { id: 'm1', jid: 'j@s.whatsapp.net', text: 'hi' } })

  for (const action of ['handoff', 'pause', 'resume']) {
    assert.deepEqual(await sup.handle('n1', action, { jid: 'j' }), { action, args: { jid: 'j' } })
  }
  await sup.stopAll()
})
