import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { parseRoutes, loadRoutes, RoutesError, botIds, isMentioned, stripMentions } from '../src/routes.mjs'
import { inspectMessage } from '../src/media.mjs'
import { createAgentClient, createContextStore } from '../src/agent.mjs'

const defaults = { url: 'https://default.example/', token: 'default-token', env: { SALES_TOKEN: 'sales' } }

test('parseRoutes fills defaults and resolves env tokens', () => {
  const routes = parseRoutes({
    '120363041234567890@g.us': { name: 'ops', agentId: 'a1' },
    '120363049876543210@g.us': { agentId: 'a2', url: 'https://other/', token: 'env:SALES_TOKEN', trigger: 'all', allowedNumbers: ['6281'] },
    '6281234567890': { agentId: 'a3' },
  }, defaults)

  const ops = routes.get('120363041234567890@g.us')
  assert.equal(ops.url, 'https://default.example')
  assert.equal(ops.token, 'default-token')
  assert.equal(ops.trigger, 'mention')
  assert.equal(ops.allowedNumbers, null)
  assert.equal(ops.isGroup, true)

  const sales = routes.get('120363049876543210@g.us')
  assert.equal(sales.token, 'sales')
  assert.equal(sales.url, 'https://other')
  assert.equal(sales.trigger, 'all')
  assert.deepEqual([...sales.allowedNumbers], ['6281'])

  assert.equal(routes.get('6281234567890').isGroup, false)
  assert.equal(routes.get('6281234567890').name, '6281234567890')
})

test('parseRoutes rejects bad config with a clear message', () => {
  assert.throws(() => parseRoutes([], defaults), RoutesError)
  assert.throws(() => parseRoutes({ '+6281': { agentId: 'a' } }, defaults), /phone number/)
  assert.throws(() => parseRoutes({ 'x@g.us': {} }, defaults), /agentId is required/)
  assert.throws(() => parseRoutes({ 'x@g.us': { agentId: 'a', trigger: 'always' } }, defaults), /trigger/)
  assert.throws(() => parseRoutes({ 'x@g.us': { agentId: 'a', token: 'env:MISSING' } }, defaults), /MISSING/)
  assert.throws(() => parseRoutes({ 'x@g.us': { agentId: 'a', allowedNumbers: '6281' } }, defaults), /list/)
})

test('loadRoutes returns no routes when the file is missing and names the file on errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'))
  assert.equal(loadRoutes(path.join(dir, 'nope.json'), defaults).size, 0)
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{ nope')
  assert.throws(() => loadRoutes(bad, defaults), /bad\.json: invalid JSON/)
})

const me = botIds({ id: '628197982161:5@s.whatsapp.net', lid: '121784602988585:5@lid' })

test('mentions match the bot by phone number or LID', () => {
  assert.deepEqual(me, ['628197982161', '121784602988585'])
  assert.equal(isMentioned(['121784602988585@lid'], me), true)
  assert.equal(isMentioned(['628197982161@s.whatsapp.net'], me), true)
  assert.equal(isMentioned(['6281111@s.whatsapp.net'], me), false)
  assert.equal(isMentioned(undefined, me), false)
})

test('stripMentions removes only the bot mention', () => {
  assert.equal(stripMentions('@121784602988585 what is our uptime?', me), 'what is our uptime?')
  assert.equal(stripMentions('hey @628197982161 ask @6281111 too', me), 'hey ask @6281111 too')
  assert.equal(stripMentions('@121784602988585 /reset', me), '/reset')
  assert.equal(stripMentions(null, me), null)
})

test('inspectMessage reports mentions from text and captions', () => {
  const key = { id: 'M', remoteJid: '1203@g.us' }
  const text = inspectMessage({ key, message: { extendedTextMessage: { text: '@1217 hi', contextInfo: { mentionedJid: ['1217@lid'] } } } })
  assert.deepEqual(text.mentions, ['1217@lid'])
  const image = inspectMessage({ key, message: { imageMessage: { caption: '@1217 look', mimetype: 'image/jpeg', contextInfo: { mentionedJid: ['1217@lid'] } } } })
  assert.deepEqual(image.mentions, ['1217@lid'])
  assert.deepEqual(inspectMessage({ key, message: { conversation: 'plain' } }).mentions, [])
})

test('agent clients sharing one store keep separate contexts and persist all of them', async () => {
  let n = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { message: { contextId: `ctx-${++n}`, parts: [{ text: 'ok' }] } } })))
  }).listen(0)
  await new Promise(r => server.once('listening', r))
  const endpoint = `http://127.0.0.1:${server.address().port}/v2/a2a/x`
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')), 'contexts.json')

  try {
    const store = createContextStore(file)
    const a = createAgentClient({ endpoint, token: 't', store, timeoutMs: 5000 })
    const b = createAgentClient({ endpoint, token: 't', store, namespace: 'agent-b|', timeoutMs: 5000 })
    await a.ask('chat', [{ text: 'hi' }])
    await b.ask('chat', [{ text: 'hi' }])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { chat: 'ctx-1', 'agent-b|chat': 'ctx-2' })
    b.reset('chat')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { chat: 'ctx-1' })
  } finally {
    server.close()
  }
})
