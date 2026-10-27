// Archestra A2A v2 client with per-chat contextId memory and inline-file fallback.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { hasFilePart, withoutFileParts } from './media.mjs'

export class AgentError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code }
  // Request shape rejected (bad params / body), as opposed to auth, not-found or server errors
  get isRejectedRequest() { return [400, 413, 422].includes(this.status) || [-32600, -32602].includes(this.code) }
  // The stored conversation is gone or belongs to another agent or token (e.g. after the
  // number was switched to a different agent). Archestra sends it as -32602 too.
  get isContextNotFound() { return this.code === -32602 && /context not found/i.test(this.message) }
}

// chat -> contextId map persisted as JSON. One store is shared by all agent clients so they
// don't overwrite each other's entries in the same file.
export function createContextStore(file) {
  const data = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const save = () => file && fs.writeFileSync(file, JSON.stringify(data, null, 2))
  return {
    get: key => data[key],
    set(key, value) { if (data[key] !== value) { data[key] = value; save() } },
    delete(key) { if (key in data) { delete data[key]; save() } },
  }
}

/**
 * @param {object} o
 * @param {string} o.endpoint   full URL of POST /v2/a2a/{agentId}
 * @param {string} o.token      Archestra bearer token
 * @param {string} [o.contextFile] path to persist chat -> contextId map (ignored when `store` is given)
 * @param {ReturnType<createContextStore>} [o.store] shared context store
 * @param {string} [o.namespace] prefix for this client's keys in the store, so two agents never share a contextId
 * @param {number} o.timeoutMs
 * @param {'auto'|'always'|'never'} o.mediaInline
 */
export function createAgentClient({ endpoint, token, contextFile, store, namespace = '', timeoutMs, mediaInline = 'auto', logger = console }) {
  const contexts = store || createContextStore(contextFile)
  const keyOf = chatId => namespace + chatId
  // In auto mode this flips to false the first time Archestra rejects an inline file part
  let inlineFiles = mediaInline !== 'never'

  // Sends with the chat's stored conversation. If Archestra no longer knows it, forgets it
  // and starts a new conversation instead of failing every message from that chat.
  async function call(chatId, parts) {
    const contextId = contexts.get(keyOf(chatId))
    try {
      return await send(chatId, parts, contextId)
    } catch (err) {
      if (!contextId || !(err instanceof AgentError) || !err.isContextNotFound) throw err
      logger.warn?.(`Archestra no longer has conversation ${contextId} for ${chatId}, starting a new one`)
      contexts.delete(keyOf(chatId))
      return send(chatId, parts, undefined)
    }
  }

  async function send(chatId, parts, contextId) {
    const message = { messageId: randomUUID(), role: 'ROLE_USER', parts }
    if (contextId) message.contextId = contextId

    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'SendMessage', params: { message } }),
        signal: AbortSignal.timeout(timeoutMs), // agent runs synchronously; tool-heavy runs can be slow
      })
    } catch (err) {
      // fetch only says "fetch failed"; the reason (DNS, TLS, refused connection) is in err.cause
      const cause = err.cause?.code || err.cause?.message
      if (cause) err.message = `${err.message} (${cause})`
      throw err
    }
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    if (!res.ok || !body) throw new AgentError(`HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status, code: body?.error?.code })
    if (body.error) throw new AgentError(body.error.message || JSON.stringify(body.error), { code: body.error.code })

    const { message: reply, task } = body.result || {}
    const ctx = reply?.contextId || task?.contextId
    if (ctx) contexts.set(keyOf(chatId), ctx)

    if (task) return 'This request needs approval in Archestra before I can continue.'
    return (reply?.parts || []).map(p => p.text).filter(Boolean).join('\n') || '(no text reply)'
  }

  return {
    get inlineFiles() { return inlineFiles },

    reset(chatId) { contexts.delete(keyOf(chatId)) },

    // Sends parts; if Archestra rejects an inline file, retries with the file described as text
    async ask(chatId, parts) {
      try {
        return { answer: await call(chatId, parts), notice: null }
      } catch (err) {
        if (!(err instanceof AgentError) || !hasFilePart(parts) || !err.isRejectedRequest) throw err
        logger.warn?.(`Archestra rejected the file part (${err.message.slice(0, 120)}), retrying without it`)
        if (mediaInline === 'auto' && err.status !== 413) {
          inlineFiles = false
          logger.warn?.('Archestra does not accept inline files over A2A; describing attachments as text from now on')
        }
        const answer = await call(chatId, withoutFileParts(parts))
        return { answer, notice: "Note: the agent couldn't receive the file itself, only a description of it." }
      }
    },
  }
}
