// Keeps one bridge process per number in line with the settings from the dashboard.

import fs from 'node:fs'
import { Instance } from './instance.mjs'
import { ID_PATTERN } from './config.mjs'

export class Supervisor {
  /**
   * @param {object} o
   * @param {string} o.entry      bridge script
   * @param {string} o.dataRoot   one folder per number lives here
   * @param {string} [o.cacheFile] last settings received, so numbers keep running while the dashboard is unreachable
   * @param {object} o.env
   * @param {(event: object) => void} o.emit
   */
  constructor({ entry, dataRoot, cacheFile, env, emit, forkFn }) {
    Object.assign(this, { entry, dataRoot, cacheFile, env, emit, forkFn })
    this.instances = new Map()
    this.queue = Promise.resolve()
  }

  loadCache() {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return null
    try { return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) } catch { return null }
  }

  // Applies are serialized so two quick syncs can't start the same number twice
  sync(numbers) {
    this.queue = this.queue.then(() => this.applySync(numbers)).catch(e => console.error('sync failed:', e))
    return this.queue
  }

  async applySync(numbers) {
    const valid = numbers.filter(n => {
      if (ID_PATTERN.test(n?.id ?? '')) return true
      console.error(`ignoring number with invalid id ${JSON.stringify(n?.id)}`)
      return false
    })
    if (this.cacheFile) {
      fs.mkdirSync(this.dataRoot, { recursive: true })
      fs.writeFileSync(this.cacheFile, JSON.stringify(valid), { mode: 0o600 })
    }

    const wanted = new Set(valid.map(n => n.id))
    // Numbers removed from this runner (deleted, or moved to another runner) are stopped.
    // Their session folder is kept; deleting a number in the dashboard unlinks it first.
    await Promise.all([...this.instances].filter(([id]) => !wanted.has(id)).map(async ([id, inst]) => {
      await inst.stop({ final: true })
      this.instances.delete(id)
      this.emit({ type: 'removed', numberId: id })
    }))

    await Promise.all(valid.map(n => {
      let inst = this.instances.get(n.id)
      if (!inst) {
        inst = new Instance({ entry: this.entry, dataRoot: this.dataRoot, env: this.env, emit: this.emit, forkFn: this.forkFn })
        this.instances.set(n.id, inst)
      }
      return inst.apply(n)
    }))
  }

  statuses() {
    return [...this.instances.values()].map(i => ({ numberId: i.id, ...i.status }))
  }

  async handle(numberId, action, args) {
    const inst = this.instances.get(numberId)
    if (!inst) throw new Error('this number is not assigned to this runner')
    switch (action) {
      case 'restart': inst.crashes = 0; await inst.restart(); return { ok: true }
      case 'unlink': await inst.unlink(); return { ok: true }
      case 'unlinkAndStop': await inst.unlink({ restart: false }); return { ok: true }
      case 'pairingCode': return inst.request('pairingCode', args)
      case 'groups': return inst.request('groups')
      default: throw new Error(`unknown action ${action}`)
    }
  }

  async stopAll() {
    await Promise.all([...this.instances.values()].map(i => i.stop()))
  }
}
