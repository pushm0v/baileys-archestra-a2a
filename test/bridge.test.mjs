import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { inspectMessage, buildParts, withoutFileParts } from '../src/media.mjs'
import { createAgentClient, AgentError } from '../src/agent.mjs'

const key = { id: 'MSG1', remoteJid: '6281@s.whatsapp.net' }
const quiet = { warn() {} }

test('inspectMessage reads plain text', () => {
  assert.deepEqual(inspectMessage({ key, message: { conversation: 'hi' } }), { text: 'hi', media: null, mentions: [] })
})

test('inspectMessage unwraps document-with-caption and ephemeral wrappers', () => {
  const msg = { key, message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: {
    documentMessage: { caption: 'summarize', mimetype: 'application/pdf', fileName: 'report.pdf', fileLength: 2048 },
  } } } } } }
  const { text, media } = inspectMessage(msg)
  assert.equal(text, 'summarize')
  assert.deepEqual(media, { kind: 'document', mediaType: 'application/pdf', filename: 'report.pdf', size: 2048, voiceNote: false })
})

test('inspectMessage names images and voice notes without file names', () => {
  const img = inspectMessage({ key, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } } })
  assert.equal(img.media.filename, 'image-MSG1.jpg')
  const voice = inspectMessage({ key, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } })
  assert.equal(voice.media.mediaType, 'audio/ogg')
  assert.equal(voice.media.voiceNote, true)
})

const opts = { allowedKinds: new Set(['image', 'document']), maxBytes: 1024, inlineFiles: true }

test('buildParts skips disallowed kinds but keeps the caption', async () => {
  const msg = { key, message: { videoMessage: { caption: 'look', mimetype: 'video/mp4', fileLength: 10 } } }
  const { parts, notice } = await buildParts(null, msg, inspectMessage(msg), opts)
  assert.deepEqual(parts, [{ text: 'look' }])
  assert.match(notice, /video attachments aren't forwarded/)
})

test('buildParts rejects oversized files before downloading', async () => {
  const msg = { key, message: { imageMessage: { mimetype: 'image/png', fileLength: 5000 } } }
  const { parts, notice } = await buildParts(null, msg, inspectMessage(msg), opts)
  assert.deepEqual(parts, [])
  assert.match(notice, /larger than/)
})

test('buildParts describes binary files without downloading when inline is off', async () => {
  const msg = { key, message: { imageMessage: { caption: 'what is this', mimetype: 'image/png', fileLength: 100 } } }
  const { parts } = await buildParts(null, msg, inspectMessage(msg), { ...opts, inlineFiles: false })
  assert.equal(parts[0].text, 'what is this')
  assert.match(parts[1].text, /image-MSG1\.png \(image\/png, 1 KB\) could not be delivered/)
})

test('withoutFileParts swaps file parts for text', () => {
  const out = withoutFileParts([{ text: 'a' }, { raw: 'AAA', mediaType: 'image/png', filename: 'x.png' }])
  assert.equal(out[0].text, 'a')
  assert.match(out[1].text, /x\.png \(image\/png\)/)
})

// Mock Archestra: rejects base64 `raw` the way a strict byte-array schema would
let server, endpoint, mode = 'reject-raw', requests = []
before(async () => {
  server = http.createServer((req, res) => {
    let b = ''
    req.on('data', d => (b += d))
    req.on('end', () => {
      const body = JSON.parse(b)
      const msg = body.params.message
      requests.push(msg)
      if (mode === 'unauthorized') { res.statusCode = 401; return res.end('{"error":"unauthorized"}') }
      // Archestra's answer to a contextId it doesn't have (or that belongs to another agent)
      if (msg.contextId === 'stale-ctx') {
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Context not found' } }))
      }
      const hasRaw = msg.parts.some(p => p.raw !== undefined)
      if (hasRaw && mode === 'reject-raw') {
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params: raw' } }))
      }
      if (hasRaw && mode === 'too-large') { res.statusCode = 413; return res.end('{"error":"too large"}') }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { message: {
        role: 'ROLE_AGENT', contextId: 'ctx-1', parts: [{ text: `got ${msg.parts.length} parts` }],
      } } }))
    })
  }).listen(0)
  await new Promise(r => server.once('listening', r))
  endpoint = `http://127.0.0.1:${server.address().port}/v2/a2a/agent`
})
after(() => server.close())

const fileParts = [{ text: 'see file' }, { raw: Buffer.from('png').toString('base64'), mediaType: 'image/png', filename: 'a.png' }]

test('agent client keeps contextId per chat', async () => {
  mode = 'ok'; requests = []
  const agent = createAgentClient({ endpoint, token: 't', timeoutMs: 5000, logger: quiet })
  await agent.ask('chat', [{ text: 'one' }])
  await agent.ask('chat', [{ text: 'two' }])
  assert.equal(requests[0].contextId, undefined)
  assert.equal(requests[1].contextId, 'ctx-1')
  agent.reset('chat')
  await agent.ask('chat', [{ text: 'three' }])
  assert.equal(requests[2].contextId, undefined)
})

test('agent client sends inline files when accepted', async () => {
  mode = 'ok'; requests = []
  const agent = createAgentClient({ endpoint, token: 't', timeoutMs: 5000, logger: quiet })
  const { answer, notice } = await agent.ask('c', fileParts)
  assert.equal(answer, 'got 2 parts')
  assert.equal(notice, null)
  assert.equal(requests[0].parts[1].mediaType, 'image/png')
  assert.equal(agent.inlineFiles, true)
})

test('auto mode falls back to text and stops inlining after a rejection', async () => {
  mode = 'reject-raw'; requests = []
  const agent = createAgentClient({ endpoint, token: 't', timeoutMs: 5000, mediaInline: 'auto', logger: quiet })
  const { answer, notice } = await agent.ask('c', fileParts)
  assert.equal(answer, 'got 2 parts')
  assert.match(notice, /couldn't receive the file/)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].parts[1].raw, undefined)
  assert.equal(agent.inlineFiles, false)
})

test('always mode falls back per message but keeps inlining', async () => {
  mode = 'reject-raw'
  const agent = createAgentClient({ endpoint, token: 't', timeoutMs: 5000, mediaInline: 'always', logger: quiet })
  await agent.ask('c', fileParts)
  assert.equal(agent.inlineFiles, true)
})

test('a 413 falls back without disabling inline files', async () => {
  mode = 'too-large'
  const agent = createAgentClient({ endpoint, token: 't', timeoutMs: 5000, logger: quiet })
  const { notice } = await agent.ask('c', fileParts)
  assert.match(notice, /couldn't receive the file/)
  assert.equal(agent.inlineFiles, true)
})

// A stored conversation from before the number was switched to another agent or token
function staleStore() {
  const data = { chat: 'stale-ctx' }
  return { get: k => data[k], set(k, v) { data[k] = v }, delete(k) { delete data[k] }, data }
}

test('a stale conversation is dropped and the message retried as a new one', async () => {
  mode = 'ok'; requests = []
  const store = staleStore()
  const agent = createAgentClient({ endpoint, token: 't', store, timeoutMs: 5000, logger: quiet })
  const { answer } = await agent.ask('chat', [{ text: 'hello' }])
  assert.equal(answer, 'got 1 parts')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].contextId, 'stale-ctx')
  assert.equal(requests[1].contextId, undefined)
  assert.equal(store.data.chat, 'ctx-1')
})

test('a stale conversation with a file keeps the file and inline mode', async () => {
  mode = 'ok'; requests = []
  const agent = createAgentClient({ endpoint, token: 't', store: staleStore(), timeoutMs: 5000, logger: quiet })
  const { answer, notice } = await agent.ask('chat', fileParts)
  assert.equal(answer, 'got 2 parts')
  assert.equal(notice, null)
  assert.equal(requests[1].parts[1].mediaType, 'image/png')
  assert.equal(agent.inlineFiles, true)
})

test('auth errors are not retried', async () => {
  mode = 'unauthorized'; requests = []
  const agent = createAgentClient({ endpoint, token: 't', timeoutMs: 5000, logger: quiet })
  await assert.rejects(agent.ask('c', fileParts), e => e instanceof AgentError && e.status === 401)
  assert.equal(requests.length, 1)
})
