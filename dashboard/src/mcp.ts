// MCP server for Archestra (Streamable HTTP, stateless, JSON responses only).
// Register it in Archestra as a remote MCP server at <dashboard>/mcp with the header
// "Authorization: Bearer <MCP key>", then give the agent its tools.

import { sha256Hex } from './crypto'
import { requestFollowup, listTopics, type ToolOutcome, type Urgency } from './handoff'

const SERVER_INFO = { name: 'whatsapp-handoff', version: '0.1.0' }
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = `Tools for the WhatsApp bridge. Every user message starts with a line like "[chat_ref=abc123]"
that identifies the WhatsApp chat. When the user wants to talk to a person, or you can't help them, call
request_human_followup with that chat_ref, a short reason and a summary. Then tell the user a person will
contact them. Never show the chat_ref to the user.`

const chatRef = { type: 'string', description: 'The value from the "[chat_ref=…]" line at the start of the user\'s latest message. Copy it exactly.' }

export const TOOLS = [
  {
    name: 'request_human_followup',
    title: 'Ask a human to follow up',
    description: 'Ask a human agent to follow up with the WhatsApp user in this chat. Use it when the user asks for a person, '
      + 'or when you cannot resolve their request. The on-duty human agents get a WhatsApp alert with your summary and the '
      + 'recent messages, and the bot stops replying in this chat for a while so the human can take over. '
      + 'Afterwards, tell the user that a person will contact them.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_ref: chatRef,
        reason: { type: 'string', description: 'Why a human is needed, in one sentence.' },
        summary: { type: 'string', description: 'What the user wants and what was already tried, so the human can pick up without reading the whole chat.' },
        topic: { type: 'string', description: 'Optional. Routes the alert to agents who handle this topic (see list_human_agent_topics).' },
        urgency: { type: 'string', enum: ['normal', 'urgent'], description: 'Optional. "urgent" marks the alert as urgent.' },
      },
      required: ['chat_ref', 'reason'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_human_agent_topics',
    title: 'List human agent topics',
    description: 'List the topics the on-duty human agents for this WhatsApp number handle, to pick a topic for request_human_followup.',
    inputSchema: { type: 'object', properties: { chat_ref: chatRef }, required: ['chat_ref'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const

type JsonRpcRequest = { jsonrpc?: string, id?: string | number | null, method?: unknown, params?: any }
type Ctx = { env: Env, keyName: string, origin: string }

class RpcError extends Error {
  constructor(public code: number, message: string) { super(message) }
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

async function callTool(ctx: Ctx, name: unknown, args: any): Promise<ToolOutcome> {
  if (typeof args !== 'object' || args === null) args = {}
  const ref = text(args.chat_ref, 64)
  if (name === 'request_human_followup') {
    const reason = text(args.reason, 500)
    if (!ref || !reason) throw new RpcError(-32602, 'chat_ref and reason are required')
    return requestFollowup(ctx.env, {
      chatRef: ref, reason, summary: text(args.summary, 2000), topic: text(args.topic, 40),
      urgency: (args.urgency === 'urgent' ? 'urgent' : 'normal') as Urgency, requestedBy: `mcp:${ctx.keyName}`, origin: ctx.origin,
    })
  }
  if (name === 'list_human_agent_topics') {
    if (!ref) throw new RpcError(-32602, 'chat_ref is required')
    return listTopics(ctx.env, ref)
  }
  throw new RpcError(-32602, `Unknown tool ${String(name)}`)
}

async function dispatch(ctx: Ctx, req: JsonRpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }
    }
    case 'ping': return {}
    case 'tools/list': return { tools: TOOLS }
    case 'tools/call': {
      const outcome = await callTool(ctx, req.params?.name, req.params?.arguments)
      return { content: [{ type: 'text', text: outcome.text }], isError: !outcome.ok }
    }
    default: throw new RpcError(-32601, `Method not found: ${String(req.method)}`)
  }
}

async function handleOne(ctx: Ctx, req: unknown): Promise<object | null> {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }
  const r = req as JsonRpcRequest
  const isNotification = !('id' in r) || r.id === undefined
  // Responses to our (nonexistent) requests, and notifications such as notifications/initialized
  if (isNotification || r.method === undefined) return null
  try {
    return { jsonrpc: '2.0', id: r.id, result: await dispatch(ctx, r) }
  } catch (e) {
    if (e instanceof RpcError) return { jsonrpc: '2.0', id: r.id, error: { code: e.code, message: e.message } }
    console.error(JSON.stringify({ message: 'mcp call failed', method: r.method, error: e instanceof Error ? e.message : String(e) }))
    return { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'Internal error' } }
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless server: no SSE stream to open and no session to end
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, { Allow: 'POST' })

  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const key = token && await env.DB.prepare('SELECT id, name FROM mcp_keys WHERE token_hash = ?').bind(await sha256Hex(token)).first<{ id: string, name: string }>()
  if (!key) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or unknown MCP key' } }, 401, { 'WWW-Authenticate': 'Bearer' })
  await env.DB.prepare('UPDATE mcp_keys SET last_used_at = ? WHERE id = ?').bind(Date.now(), key.id).run()

  let body: unknown
  try { body = await request.json() } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }
  const ctx: Ctx = { env, keyName: key.name, origin: new URL(request.url).origin }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(r => handleOne(ctx, r)))).filter(Boolean)
    return out.length ? json(out) : new Response(null, { status: 202 })
  }
  const out = await handleOne(ctx, body)
  return out ? json(out) : new Response(null, { status: 202 })
}
