import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:workers'
import { ORIGIN, worker, call, connectRunner, connectBrowser } from './helpers'
import { csvField, purgeOldMessages } from '../src/conversations'
import { pickAgents, alertText } from '../src/handoff'

const CUSTOMER = '628111222333'
const CHAT = `${CUSTOMER}@s.whatsapp.net`
const REF = 'cTestChatRef0001'

async function mcp(key: string | null, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (key) headers.Authorization = `Bearer ${key}`
  return worker.fetch(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })

let seq = 0
const message = (numberId: string, fields: Record<string, unknown>) => ({
  numberId, id: `msg-${String(++seq).padStart(6, '0')}`, jid: CHAT, at: 1_700_000_000_000 + seq * 1000, direction: 'in', kind: 'user',
  sender: CUSTOMER, senderName: 'Sari', text: 'hello', media: null, waId: `WA${seq}`,
  chat: { ref: REF, name: 'Sari', phone: CUSTOMER }, ...fields,
})

async function setup() {
  const runner = await (await call('POST', '/api/runners', { body: { name: 'handoff-runner' } })).json<{ id: string, token: string }>()
  const rws = await connectRunner(runner.token)
  rws.send({ type: 'hello', statuses: [] })
  await rws.next(m => m.type === 'sync')
  const number = await (await call('POST', '/api/numbers', { body: {
    name: 'Support Line', runnerId: runner.id, agentId: 'agent-1', handoffEnabled: true, handoffPauseMinutes: 30,
    humanAgents: [
      { name: 'Budi', phone: '+628999000111', topics: ['Billing'] },
      { name: 'Ana', phone: '628999000222', topics: [] },
      { name: 'Off', phone: '628999000333', onDuty: false },
    ],
  } })).json<any>()
  const sync = await rws.next(m => m.type === 'sync' && m.numbers.length === 1)
  const key = await (await call('POST', '/api/mcp-keys', { body: { name: 'archestra' } })).json<{ token: string, url: string }>()
  return { runner, rws, number, sync, key }
}

describe('recording, handoff and export', () => {
  it('records messages, hands a chat to a human over MCP, and exports it', async () => {
    const { rws, number, sync, key } = await setup()

    // Human agents stay in the dashboard; the runner only learns the switches
    expect(sync.numbers[0]).toMatchObject({ recordMessages: true, handoff: true })
    expect(sync.numbers[0].humanAgents).toBeUndefined()
    expect(number.humanAgents.map((a: any) => [a.name, a.phone, a.topics, a.onDuty])).toEqual([
      ['Budi', '628999000111', ['billing'], true], ['Ana', '628999000222', [], true], ['Off', '628999000333', [], false]])
    expect(key.url).toBe(`${ORIGIN}/mcp`)

    const browser = await connectBrowser()
    await browser.next(m => m.type === 'snapshot')

    // The runner reports messages in batches; each batch is acknowledged, and resending is harmless
    const batch = [
      message(number.id, { text: 'My invoice is wrong' }),
      message(number.id, { direction: 'out', kind: 'agent', sender: null, senderName: null, text: 'Let me check that for you.', chat: { ref: null } }),
      message(number.id, { text: '=HYPERLINK("http://evil")', media: { kind: 'image', mediaType: 'image/jpeg', filename: 'bill.jpg', size: 1234 } }),
      message('not-my-number', { text: 'should be dropped' }),
    ]
    rws.send({ type: 'messages', batch: 'b1', items: batch })
    expect(await rws.next(m => m.type === 'messages_ack')).toEqual({ type: 'messages_ack', batch: 'b1' })
    expect(await browser.next(m => m.type === 'chat')).toMatchObject({ numberId: number.id, jid: CHAT })
    rws.send({ type: 'messages', batch: 'b2', items: batch.slice(0, 2) })
    await rws.next(m => m.type === 'messages_ack' && m.batch === 'b2')

    const chats = await (await call('GET', `/api/numbers/${number.id}/chats`)).json<any[]>()
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ jid: CHAT, name: 'Sari', phone: CUSTOMER, messages: 3, openHandoffs: 0, pausedUntil: null })
    expect(chats[0]).not.toHaveProperty('ref')

    // MCP: unauthenticated calls are refused
    expect((await mcp(null, rpc(1, 'tools/list'))).status).toBe(401)
    expect((await mcp('mk_wrong', rpc(1, 'tools/list'))).status).toBe(401)

    const init = await (await mcp(key.token, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'archestra', version: '1' } }))).json<any>()
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'whatsapp-handoff' } })
    expect((await mcp(key.token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    const tools = await (await mcp(key.token, rpc(2, 'tools/list'))).json<any>()
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(['request_human_followup', 'list_human_agent_topics'])
    expect((await (await mcp(key.token, rpc(3, 'nope'))).json<any>()).error.code).toBe(-32601)

    const topics = await (await mcp(key.token, rpc(4, 'tools/call', { name: 'list_human_agent_topics', arguments: { chat_ref: REF } }))).json<any>()
    expect(topics.result.content[0].text).toContain('billing: 1 on duty')
    expect(topics.result.content[0].text).toContain('(any topic): 1 on duty')

    const unknown = await (await mcp(key.token, rpc(5, 'tools/call', { name: 'request_human_followup', arguments: { chat_ref: 'cNotARealRef0000', reason: 'x' } }))).json<any>()
    expect(unknown.result.isError).toBe(true)
    expect(unknown.result.content[0].text).toMatch(/Unknown chat_ref/)

    // The tool call alerts the on-duty agents for the topic through the runner, and pauses the chat
    const pending = mcp(key.token, rpc(6, 'tools/call', { name: 'request_human_followup', arguments: {
      chat_ref: REF, reason: 'Invoice dispute', summary: 'Customer says invoice #12 is double charged', topic: 'billing', urgency: 'urgent' } }))
    const req = await rws.next(m => m.type === 'request' && m.action === 'handoff')
    expect(req.numberId).toBe(number.id)
    expect(req.args).toMatchObject({ jid: CHAT, recipients: ['628999000111', '628999000222'], pauseMinutes: 30 })
    expect(req.args.text).toContain('URGENT')
    expect(req.args.text).toContain(`https://wa.me/${CUSTOMER}`)
    expect(req.args.text).toContain('Sari: My invoice is wrong')
    expect(req.args.text).toContain('Bot: Let me check that for you.')
    expect(req.args.text).toContain(`${ORIGIN}/#/numbers/${number.id}/chats/${encodeURIComponent(CHAT)}`)
    const pausedUntil = Date.now() + 30 * 60_000
    rws.send({ type: 'response', id: req.id, ok: true, result: { results: [{ phone: '628999000111', ok: true }, { phone: '628999000222', ok: false, error: 'not on WhatsApp' }], pausedUntil } })
    const called = await (await pending).json<any>()
    expect(called.result.isError).toBe(false)
    expect(called.result.content[0].text).toMatch(/Alerted Budi on WhatsApp/)

    // Asking again soon doesn't alert anyone twice
    const again = await (await mcp(key.token, rpc(7, 'tools/call', { name: 'request_human_followup', arguments: { chat_ref: REF, reason: 'again' } }))).json<any>()
    expect(again.result.content[0].text).toMatch(/already requested/)

    const detail = await (await call('GET', `/api/numbers/${number.id}/chats/${encodeURIComponent(CHAT)}`)).json<any>()
    expect(detail.chat.pausedUntil).toBe(pausedUntil)
    expect(detail.messages.map((m: any) => m.text)).toEqual(['My invoice is wrong', 'Let me check that for you.', '=HYPERLINK("http://evil")'])
    expect(detail.handoffs).toHaveLength(1)
    expect(detail.handoffs[0]).toMatchObject({ status: 'open', topic: 'billing', urgency: 'urgent', requestedBy: 'mcp:archestra',
      notified: [{ name: 'Budi', ok: true }, { name: 'Ana', ok: false, error: 'not on WhatsApp' }] })
    expect((await (await call('GET', `/api/numbers/${number.id}/handoffs?status=open`)).json<any[]>())).toHaveLength(1)

    // Exports: CSV guards against formulas, JSON Lines keeps the fields
    const csv = await call('GET', `/api/numbers/${number.id}/export?format=csv`)
    expect(csv.headers.get('Content-Type')).toContain('text/csv')
    expect(csv.headers.get('Content-Disposition')).toMatch(/attachment; filename="whatsapp-support-line-\d{4}-\d{2}-\d{2}\.csv"/)
    const csvText = await csv.text()
    expect(csvText.split('\r\n').filter(Boolean)).toHaveLength(4)
    expect(csvText).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvText).toContain('"bill.jpg"')

    const jsonl = await (await call('GET', `/api/numbers/${number.id}/export?format=jsonl&jid=${encodeURIComponent(CHAT)}&from=${batch[1].at}`)).text()
    const rows = jsonl.trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(r => [r.kind, r.text])).toEqual([['agent', 'Let me check that for you.'], ['user', '=HYPERLINK("http://evil")']])
    expect(rows[1]).toMatchObject({ number: 'Support Line', chat: CHAT, chatName: 'Sari', media: { kind: 'image', filename: 'bill.jpg' } })
    expect((await call('GET', `/api/numbers/${number.id}/export?format=xml`)).status).toBe(400)

    // Resume: tells the runner, clears the pause and closes the handoff
    const resuming = call('POST', `/api/numbers/${number.id}/chats/${encodeURIComponent(CHAT)}/resume`)
    const resume = await rws.next(m => m.type === 'request' && m.action === 'resume')
    expect(resume.args).toMatchObject({ jid: CHAT })
    rws.send({ type: 'response', id: resume.id, ok: true, result: { pausedUntil: null } })
    expect(await (await resuming).json()).toEqual({ pausedUntil: null })
    const after = await (await call('GET', `/api/numbers/${number.id}/chats/${encodeURIComponent(CHAT)}`)).json<any>()
    expect(after.chat.pausedUntil).toBeNull()
    expect(after.handoffs[0]).toMatchObject({ status: 'resolved', resolvedBy: 'boss@example.com' })

    const audit = await (await call('GET', '/api/audit')).json<any[]>()
    expect(audit.map(a => a.action)).toEqual(expect.arrayContaining(['mcp_key.add', 'handoff.request', 'conversations.export', 'chat.resume']))
  })

  it('keeps conversations away from viewers, and MCP keys with admins', async () => {
    const { number } = await setup()
    await call('POST', '/api/users', { body: { email: 'viewer@example.com', role: 'viewer' } })
    await call('POST', '/api/users', { body: { email: 'op@example.com', role: 'operator' } })
    for (const path of [`/api/numbers/${number.id}/chats`, `/api/numbers/${number.id}/export?format=csv`, `/api/numbers/${number.id}/handoffs`]) {
      expect((await call('GET', path, { email: 'viewer@example.com' })).status).toBe(403)
      expect((await call('GET', path, { email: 'op@example.com' })).status).toBe(200)
    }
    expect((await call('GET', '/api/mcp-keys', { email: 'op@example.com' })).status).toBe(403)
    expect((await call('POST', '/api/mcp-keys', { email: 'op@example.com', body: { name: 'x' } })).status).toBe(403)

    // Revoked keys stop working
    const key = await (await call('POST', '/api/mcp-keys', { body: { name: 'temp' } })).json<{ id: string, token: string }>()
    expect((await mcp(key.token, rpc(1, 'ping'))).status).toBe(200)
    expect((await call('DELETE', `/api/mcp-keys/${key.id}`)).status).toBe(204)
    expect((await mcp(key.token, rpc(1, 'ping'))).status).toBe(401)
  })

  it('reports a failed handoff when the number has handoff off or nobody on duty', async () => {
    const { rws, number, key } = await setup()
    rws.send({ type: 'messages', batch: 'x', items: [message(number.id, { chat: { ref: 'cOffDutyChat0001' }, jid: '628000@s.whatsapp.net' })] })
    await rws.next(m => m.type === 'messages_ack')

    // Everyone off duty: nothing is sent, the failure is logged on the dashboard
    await call('PUT', `/api/numbers/${number.id}`, { body: { ...number, humanAgents: [{ name: 'Off', phone: '628999000333', onDuty: false }] } })
    const res = await (await mcp(key.token, rpc(1, 'tools/call', { name: 'request_human_followup', arguments: { chat_ref: 'cOffDutyChat0001', reason: 'help' } }))).json<any>()
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/No human agent is on duty/)
    const handoffs = await (await call('GET', `/api/numbers/${number.id}/handoffs`)).json<any[]>()
    expect(handoffs[0]).toMatchObject({ status: 'failed', jid: '628000@s.whatsapp.net' })

    await call('PUT', `/api/numbers/${number.id}`, { body: { ...number, handoffEnabled: false } })
    const off = await (await mcp(key.token, rpc(2, 'tools/call', { name: 'request_human_followup', arguments: { chat_ref: 'cOffDutyChat0001', reason: 'help' } }))).json<any>()
    expect(off.result.content[0].text).toMatch(/turned off/)
  })

  it('validates human agents', async () => {
    const bad = await call('POST', '/api/numbers', { body: { name: 'x', agentId: 'a', humanAgents: [{ name: '', phone: 'abc' }, { name: 'B', phone: '62811111' }, { name: 'C', phone: '62811111' }] } })
    expect(bad.status).toBe(400)
    const { errors } = await bad.json<any>()
    expect(errors).toEqual(expect.arrayContaining(['human agent 1: name is required', expect.stringMatching(/human agent 1: phone must be digits/), 'human agent phone listed twice: 62811111']))
  })
})

describe('handoff helpers', () => {
  const agents = [
    { id: '1', name: 'Billing', phone: '1', topics: ['billing'], onDuty: true },
    { id: '2', name: 'Any', phone: '2', topics: [], onDuty: true },
    { id: '3', name: 'Sales', phone: '3', topics: ['sales'], onDuty: true },
    { id: '4', name: 'Away', phone: '4', topics: ['billing'], onDuty: false },
  ]
  it('picks on-duty agents for a topic, falling back to everyone on duty', () => {
    expect(pickAgents(agents, 'Billing').map(a => a.name)).toEqual(['Billing', 'Any'])
    expect(pickAgents(agents, 'shipping').map(a => a.name)).toEqual(['Billing', 'Any', 'Sales'])
    expect(pickAgents(agents, null).map(a => a.name)).toEqual(['Billing', 'Any', 'Sales'])
  })

  it('writes an alert without empty lines for missing fields', () => {
    const text = alertText({ numberName: 'Ops', chatName: 'Team', isGroup: true, customer: { name: null, phone: null }, reason: 'r', urgency: 'normal', recent: [], pauseMinutes: 0, link: 'L' })
    expect(text).toBe('🙋 Human follow-up requested on Ops\nGroup: Team · requested by unknown\nReason: r\n\nFull chat: L')
  })

  it('quotes CSV fields and neutralises formulas', () => {
    expect(csvField('a"b')).toBe('"a""b"')
    expect(csvField('+1 555')).toBe(`"'+1 555"`)
    expect(csvField(null)).toBe('""')
  })

  it('deletes messages past the retention window', async () => {
    const db = env.DB
    const runner = crypto.randomUUID()
    await db.prepare('INSERT INTO runners (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(runner, 'r', crypto.randomUUID(), 0).run()
    await db.prepare(`INSERT INTO numbers (id, name, runner_id, agent_id, created_at, updated_at) VALUES ('ret', 'ret', ?, 'a', 0, 0)`).bind(runner).run()
    const now = 100 * 86_400_000
    await db.batch([
      db.prepare(`INSERT INTO chats (number_id, jid, first_at, last_at) VALUES ('ret', 'old@s.whatsapp.net', 0, 0)`),
      db.prepare(`INSERT INTO messages (id, number_id, jid, at, direction, kind) VALUES ('old1', 'ret', 'old@s.whatsapp.net', 0, 'in', 'user')`),
      db.prepare(`INSERT INTO messages (id, number_id, jid, at, direction, kind) VALUES ('new1', 'ret', 'old@s.whatsapp.net', ?, 'in', 'user')`).bind(now),
    ])
    expect(await purgeOldMessages(db, 30, now)).toBe(1)
    const left = await db.prepare(`SELECT id FROM messages WHERE number_id = 'ret'`).all()
    expect(left.results.map(r => r.id)).toEqual(['new1'])
  })
})
