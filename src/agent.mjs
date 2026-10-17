// Archestra A2A v2 client with per-chat contextId memory and inline-file fallback.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { hasFilePart, withoutFileParts } from './media.mjs'

export class AgentError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code }
  // Request shape rejected (bad params / body), as opposed to auth, not-found or server errors
  get isRejectedRequest() { return [400, 413, 422].includes(this.status) || [-32600, -32602].includes(this.code) }
}

/**
 * @param {object} o
 * @param {string} o.endpoint   full URL of POST /v2/a2a/{agentId}
 * @param {string} o.token      Archestra bearer token
 * @param {string} o.contextFile path to persist chat -> contextId map
 * @param {number} o.timeoutMs
 * @param {'auto'|'always'|'never'} o.mediaInline
 */
export function createAgentClient({ endpoint, token, contextFile, timeoutMs, mediaInline = 'auto', logger = console }) {
  const contexts = contextFile && fs.existsSync(contextFile) ? JSON.parse(fs.readFileSync(contextFile, 'utf8')) : {}
  const save = () => contextFile && fs.writeFileSync(contextFile, JSON.stringify(contexts, null, 2))
  // In auto mode this flips to false the first time Archestra rejects an inline file part
  let inlineFiles = mediaInline !== 'never'

  async function call(chatId, parts) {
    const message = { messageId: randomUUID(), role: 'ROLE_USER', parts }
    if (contexts[chatId]) message.contextId = contexts[chatId]

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
    if (ctx && ctx !== contexts[chatId]) { contexts[chatId] = ctx; save() }

    if (task) return 'This request needs approval in Archestra before I can continue.'
    return (reply?.parts || []).map(p => p.text).filter(Boolean).join('\n') || '(no text reply)'
  }

  return {
    get inlineFiles() { return inlineFiles },

    reset(chatId) { delete contexts[chatId]; save() },

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
