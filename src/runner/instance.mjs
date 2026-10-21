// One supervised bridge process per WhatsApp number.

import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { bridgeEnv, ConfigError } from './config.mjs'
import { reconnectDelay } from '../backoff.mjs'

const LOGGED_OUT_EXIT = 3
const STOP_GRACE_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000

export class Instance {
  /**
   * @param {object} o
   * @param {string} o.entry     bridge script to fork
   * @param {string} o.dataRoot  directory with one folder per number
   * @param {object} o.env       runner environment
   * @param {(event: object) => void} o.emit  status / qr / log / activity events
   */
  constructor({ entry, dataRoot, env, emit, forkFn = fork }) {
    Object.assign(this, { entry, dataRoot, env, emit, forkFn })
    this.config = null
    this.child = null
    this.stopping = false
    this.crashes = 0
    this.restartTimer = null
    this.pending = new Map()
    this.status = { state: 'stopped' }
  }

  get id() { return this.config?.id }
  get dir() { return path.join(this.dataRoot, this.id) }

  setStatus({ state, detail = null, ...rest }) {
    this.status = { ...this.status, ...rest, state, detail, at: Date.now() }
    this.emit({ type: 'status', numberId: this.id, ...this.status })
  }

  // Apply new settings; restarts the process only when something it uses has changed
  async apply(config) {
    const changed = JSON.stringify(config) !== JSON.stringify(this.config)
    this.config = config
    if (!config.enabled) return this.stop({ final: true })
    if (changed || (!this.child && this.status.state !== 'logged_out')) await this.restart()
  }

  async restart() {
    await this.stop()
    this.start()
  }

  start() {
    clearTimeout(this.restartTimer)
    let env
    try {
      env = bridgeEnv(this.config, this.env, this.dataRoot)
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      return this.setStatus({ state: 'error', detail: e.message })
    }
    fs.mkdirSync(this.dir, { recursive: true })
    this.stopping = false
    this.setStatus({ state: 'starting' })

    const child = this.forkFn(this.entry, [], { env, silent: true })
    this.child = child
    for (const [stream, src] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      if (!src) continue
      readline.createInterface({ input: src }).on('line', line => this.emit({ type: 'log', numberId: this.id, stream, line, at: Date.now() }))
    }
    child.on('message', msg => this.onChildMessage(msg))
    child.on('exit', code => this.onExit(child, code))
  }

  onChildMessage(msg) {
    if (msg?.type === 'status') {
      const { type, ...rest } = msg
      if (rest.state === 'connected') { this.crashes = 0; this.emit({ type: 'qr', numberId: this.id, qr: null }) }
      this.setStatus(rest)
    } else if (msg?.type === 'qr') {
      this.setStatus({ state: 'waiting_for_scan' })
      this.emit({ type: 'qr', numberId: this.id, qr: msg.qr })
    } else if (msg?.type === 'activity') {
      this.emit({ type: 'activity', numberId: this.id, at: msg.at })
    } else if (msg?.type === 'response') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))
    }
  }

  onExit(child, code) {
    if (this.child !== child) return
    this.child = null
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('bridge process exited')) }
    this.pending.clear()
    this.emit({ type: 'qr', numberId: this.id, qr: null })
    if (this.stopping) return this.setStatus({ state: 'stopped' })
    if (code === LOGGED_OUT_EXIT) return this.setStatus({ state: 'logged_out', detail: 'Unlinked from WhatsApp. Use "Re-pair" to link it again.' })
    const delay = reconnectDelay(this.crashes++)
    this.setStatus({ state: 'crashed', detail: `exited with code ${code}, restarting in ${Math.round(delay / 1000)}s` })
    this.restartTimer = setTimeout(() => this.config?.enabled && !this.child && this.start(), delay)
  }

  // final: the number is disabled or removed, so report it as stopped even if nothing was running
  async stop({ final = false } = {}) {
    clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) {
      if (final && this.status.state !== 'stopped') this.setStatus({ state: 'stopped' })
      return
    }
    this.stopping = true
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }

  // Ask the bridge process to do something (pairing code, list groups, log out)
  request(action, args = {}) {
    const child = this.child
    if (!child?.connected) return Promise.reject(new Error('this number is not running'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${action} timed out`)) }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      child.send({ type: 'request', id, action, args })
    })
  }

  // Log out of WhatsApp (best effort), delete the session and start fresh with a new QR code
  async unlink({ restart = true } = {}) {
    if (this.status.state === 'connected') await this.request('logout').catch(() => {})
    await this.stop()
    fs.rmSync(path.join(this.dir, 'auth'), { recursive: true, force: true })
    fs.rmSync(path.join(this.dir, 'contexts.json'), { force: true })
    this.crashes = 0
    if (restart && this.config?.enabled) this.start()
    else this.setStatus({ state: 'stopped' })
  }
}
