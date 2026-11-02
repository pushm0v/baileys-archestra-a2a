// Recorded messages waiting to reach the dashboard. Sent in batches, one batch in flight at a
// time; a batch stays queued until the dashboard acknowledges it, so a dropped connection only
// means it is sent again (the dashboard ignores messages it already has).
// Kept in memory: messages recorded while the dashboard is unreachable survive reconnects,
// but not a runner restart.

import { randomUUID } from 'node:crypto'

export class Outbox {
  /**
   * @param {object} o
   * @param {(msg: object) => boolean} o.send  sends one WebSocket message; false when not connected
   * @param {number} [o.max]        oldest messages are dropped beyond this many
   * @param {number} [o.batchSize]
   * @param {number} [o.delayMs]    how long to gather messages before sending a batch
   * @param {number} [o.ackTimeoutMs]
   */
  constructor({ send, max = 20_000, batchSize = 100, delayMs = 1000, ackTimeoutMs = 30_000, logger = console }) {
    Object.assign(this, { send, max, batchSize, delayMs, ackTimeoutMs, logger })
    this.queue = []
    this.inflight = null
    this.timer = null
    this.dropped = 0
  }

  get size() { return this.queue.length + (this.inflight?.items.length ?? 0) }

  push(item) {
    this.queue.push(item)
    const over = this.size - this.max
    if (over > 0) {
      this.queue.splice(0, over)
      if (!this.dropped) this.logger.warn?.(`dashboard unreachable for a while: dropping the oldest recorded messages (keeping ${this.max})`)
      this.dropped += over
    }
    this.schedule()
  }

  schedule(delay = this.delayMs) {
    if (this.timer || this.inflight || !this.queue.length) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, delay)
  }

  flush() {
    if (this.inflight || !this.queue.length) return
    const items = this.queue.splice(0, this.batchSize)
    const batch = randomUUID()
    if (!this.send({ type: 'messages', batch, items })) {
      this.queue.unshift(...items)
      return // not connected; connected() sends them
    }
    this.inflight = { batch, items, timer: setTimeout(() => this.requeue(), this.ackTimeoutMs) }
  }

  ack(batch) {
    if (this.inflight?.batch !== batch) return
    clearTimeout(this.inflight.timer)
    this.inflight = null
    if (this.dropped) { this.logger.warn?.(`${this.dropped} recorded message(s) were dropped while the dashboard was unreachable`); this.dropped = 0 }
    // More waiting: send the next batch now instead of after the delay
    if (this.queue.length) this.flush()
  }

  // The batch was never acknowledged: put it back in front, in order
  requeue() {
    if (!this.inflight) return
    clearTimeout(this.inflight.timer)
    this.queue.unshift(...this.inflight.items)
    this.inflight = null
    this.schedule()
  }

  disconnected() {
    this.requeue()
    clearTimeout(this.timer)
    this.timer = null
  }

  connected() {
    this.flush()
  }
}
