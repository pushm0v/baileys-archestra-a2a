import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { quietSignalLogs, signalLogLine } from '../src/quiet-signal.mjs'

const require = createRequire(import.meta.url)

// A console that records what reaches it
function fakeConsole() {
  const lines = []
  const target = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) target[level] = (...args) => lines.push([level, ...args])
  return { target, lines }
}

const session = () => ({
  currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('secret-private-key') }, rootKey: Buffer.from('secret-root-key') },
  indexInfo: { closed: -1, baseKey: Buffer.from('base') },
})

test('libsignal session dumps lose the session record', () => {
  const { target, lines } = fakeConsole()
  quietSignalLogs(target)
  target.info('Closing session:', session())
  target.info('Opening session:', session())
  target.warn('Session already closed', session())
  target.info('Removing old closed session:', session())
  assert.deepEqual(lines, [
    ['info', 'signal: closing session'],
    ['info', 'signal: opening session'],
    ['warn', 'signal: session already closed'],
    ['info', 'signal: removing old closed session'],
  ])
})

test("the bridge's own logs pass through unchanged", () => {
  const { target, lines } = fakeConsole()
  quietSignalLogs(target)
  const err = new Error('boom')
  target.log('123@lid: agent replied in 5.4s')
  target.error('123@lid: agent call failed:', err.message)
  target.log({ closing: 'session' })
  assert.deepEqual(lines, [
    ['log', '123@lid: agent replied in 5.4s'],
    ['error', '123@lid: agent call failed:', 'boom'],
    ['log', { closing: 'session' }],
  ])
  assert.equal(signalLogLine(['Closing the door']), null)
})

test("libsignal's own closeSession logs no keys", () => {
  const SessionRecord = require('libsignal/src/session_record.js')
  const { target, lines } = fakeConsole()
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  const real = Object.fromEntries(levels.map(l => [l, console[l]]))
  Object.assign(console, target)
  try {
    quietSignalLogs(console)
    new SessionRecord().closeSession(session())
  } finally {
    Object.assign(console, real)
  }
  assert.deepEqual(lines, [['info', 'signal: closing session']])
  assert.doesNotMatch(JSON.stringify(lines), /secret/)
})
