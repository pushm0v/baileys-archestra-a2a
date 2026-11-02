// Input validation for the dashboard API. Mirrors the rules in src/routes.mjs of the bridge.

export const MEDIA_KINDS = ['image', 'document', 'audio', 'video', 'sticker'] as const
export const MEDIA_INLINE = ['auto', 'always', 'never'] as const
export const TRIGGERS = ['mention', 'all'] as const
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const PHONE = /^\d{5,20}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type RouteInput = {
  key: string
  name: string | null
  agentId: string
  url: string | null
  tokenRef: string | null
  trigger: (typeof TRIGGERS)[number]
  allowedNumbers: string[] | null
}

export type NumberInput = {
  name: string
  runnerId: string | null
  enabled: boolean
  agentId: string
  archestraUrl: string | null
  tokenRef: string | null
  allowedNumbers: string[]
  mediaTypes: string[] | null
  maxMediaMb: number | null
  mediaInline: (typeof MEDIA_INLINE)[number] | null
  agentTimeoutMs: number | null
  routes: RouteInput[]
  recordMessages: boolean
  handoffEnabled: boolean
  handoffPauseMinutes: number | null
  humanAgents: HumanAgentInput[]
}

export type HumanAgentInput = {
  name: string
  phone: string
  topics: string[]
  onDuty: boolean
}

export const MAX_HUMAN_AGENTS = 50

export class ValidationError extends Error {
  constructor(public errors: string[]) { super(errors.join('; ')) }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const blank = (v: unknown) => v === undefined || v === null || v === ''

function str(o: Obj, key: string, errors: string[], where: string, { required = false, max = 200 } = {}): string | null {
  const v = o[key]
  if (blank(v)) {
    if (required) errors.push(`${where}${key} is required`)
    return null
  }
  if (typeof v !== 'string') { errors.push(`${where}${key} must be text`); return null }
  const t = v.trim()
  if (t.length > max) errors.push(`${where}${key} is too long (max ${max})`)
  if (required && !t) errors.push(`${where}${key} is required`)
  return t || null
}

function url(o: Obj, key: string, errors: string[], where: string): string | null {
  const v = str(o, key, errors, where, { max: 500 })
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
  } catch {
    errors.push(`${where}${key} must be an http(s) URL`)
  }
  return v.replace(/\/$/, '')
}

function envName(o: Obj, key: string, errors: string[], where: string): string | null {
  const v = str(o, key, errors, where, { max: 100 })
  if (v && !ENV_NAME.test(v)) errors.push(`${where}${key} must be an env var name like SALES_TOKEN (capitals, digits, _)`)
  return v
}

function phones(o: Obj, key: string, errors: string[], where: string): string[] | null {
  const v = o[key]
  if (blank(v)) return null
  if (!Array.isArray(v)) { errors.push(`${where}${key} must be a list`); return null }
  const out = v.map(x => String(x).trim().replace(/^\+/, '')).filter(Boolean)
  // LIDs (long hidden IDs) are digits too, so only the shape is checked
  const bad = out.filter(x => !PHONE.test(x))
  if (bad.length) errors.push(`${where}${key}: ${bad.join(', ')} must be digits with country code (no +, spaces or dashes)`)
  return [...new Set(out)]
}

function int(o: Obj, key: string, errors: string[], where: string, min: number, max: number): number | null {
  const v = o[key]
  if (blank(v)) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${where}${key} must be a whole number from ${min} to ${max}`); return null }
  return n
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], errors: string[], where: string): T | null {
  const v = o[key]
  if (blank(v)) return null
  if (!allowed.includes(v as T)) { errors.push(`${where}${key} must be one of ${allowed.join(', ')}`); return null }
  return v as T
}

function route(r: unknown, i: number, errors: string[]): RouteInput | null {
  const where = `route ${i + 1}: `
  if (!isObj(r)) { errors.push(`${where}must be an object`); return null }
  const key = str(r, 'key', errors, where, { required: true, max: 100 })
  if (key && !key.endsWith('@g.us') && !/^\d+$/.test(key)) errors.push(`${where}key must be a group ID (…@g.us) or a phone number (digits only, country code, no +)`)
  return {
    key: key ?? '',
    name: str(r, 'name', errors, where, { max: 80 }),
    agentId: str(r, 'agentId', errors, where, { required: true }) ?? '',
    url: url(r, 'url', errors, where),
    tokenRef: envName(r, 'tokenRef', errors, where),
    trigger: oneOf(r, 'trigger', TRIGGERS, errors, where) ?? 'mention',
    allowedNumbers: phones(r, 'allowedNumbers', errors, where),
  }
}

function bool(o: Obj, key: string, errors: string[], where: string, fallback: boolean): boolean {
  const v = o[key]
  if (blank(v)) return fallback
  if (typeof v !== 'boolean') { errors.push(`${where}${key} must be true or false`); return fallback }
  return v
}

// Topics are matched case-insensitively against the topic the agent passes
export const normalizeTopic = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')

function humanAgent(a: unknown, i: number, errors: string[]): HumanAgentInput | null {
  const where = `human agent ${i + 1}: `
  if (!isObj(a)) { errors.push(`${where}must be an object`); return null }
  const phone = str(a, 'phone', errors, where, { required: true, max: 25 })?.replace(/^\+/, '') ?? ''
  if (phone && !PHONE.test(phone)) errors.push(`${where}phone must be digits with country code (no +, spaces or dashes)`)
  let topics: string[] = []
  if (!blank(a.topics)) {
    if (!Array.isArray(a.topics) || a.topics.some(t => typeof t !== 'string')) errors.push(`${where}topics must be a list of words`)
    else topics = [...new Set((a.topics as string[]).map(normalizeTopic).filter(Boolean))]
    if (topics.some(t => t.length > 40)) errors.push(`${where}each topic must be at most 40 characters`)
  }
  return {
    name: str(a, 'name', errors, where, { required: true, max: 80 }) ?? '',
    phone,
    topics,
    onDuty: bool(a, 'onDuty', errors, where, true),
  }
}

export function parseNumber(body: unknown): NumberInput {
  const errors: string[] = []
  if (!isObj(body)) throw new ValidationError(['body must be a JSON object'])
  const media = body.mediaTypes
  let mediaTypes: string[] | null = null
  if (!blank(media)) {
    if (!Array.isArray(media) || media.some(m => !MEDIA_KINDS.includes(m))) errors.push(`mediaTypes must be a list of ${MEDIA_KINDS.join(', ')}`)
    else mediaTypes = [...new Set(media as string[])]
  }
  const routesRaw = body.routes ?? []
  if (!Array.isArray(routesRaw)) errors.push('routes must be a list')
  const routes = (Array.isArray(routesRaw) ? routesRaw : []).map((r, i) => route(r, i, errors)).filter((r): r is RouteInput => r !== null)
  const keys = routes.map(r => r.key)
  const dupes = keys.filter((k, i) => k && keys.indexOf(k) !== i)
  if (dupes.length) errors.push(`duplicate route keys: ${[...new Set(dupes)].join(', ')}`)
  if (!blank(body.enabled) && typeof body.enabled !== 'boolean') errors.push('enabled must be true or false')
  const agentsRaw = body.humanAgents ?? []
  if (!Array.isArray(agentsRaw)) errors.push('humanAgents must be a list')
  else if (agentsRaw.length > MAX_HUMAN_AGENTS) errors.push(`at most ${MAX_HUMAN_AGENTS} human agents per number`)
  const humanAgents = (Array.isArray(agentsRaw) ? agentsRaw : []).map((a, i) => humanAgent(a, i, errors)).filter((a): a is HumanAgentInput => a !== null)
  const phonesSeen = humanAgents.map(a => a.phone)
  const dupePhones = phonesSeen.filter((p, i) => p && phonesSeen.indexOf(p) !== i)
  if (dupePhones.length) errors.push(`human agent phone listed twice: ${[...new Set(dupePhones)].join(', ')}`)

  const input: NumberInput = {
    name: str(body, 'name', errors, '', { required: true, max: 80 }) ?? '',
    runnerId: str(body, 'runnerId', errors, '', { max: 64 }),
    enabled: body.enabled !== false,
    agentId: str(body, 'agentId', errors, '', { required: true }) ?? '',
    archestraUrl: url(body, 'archestraUrl', errors, ''),
    tokenRef: envName(body, 'tokenRef', errors, ''),
    allowedNumbers: phones(body, 'allowedNumbers', errors, '') ?? [],
    mediaTypes,
    maxMediaMb: int(body, 'maxMediaMb', errors, '', 1, 100),
    mediaInline: oneOf(body, 'mediaInline', MEDIA_INLINE, errors, ''),
    agentTimeoutMs: int(body, 'agentTimeoutMs', errors, '', 1000, 3_600_000),
    routes,
    recordMessages: bool(body, 'recordMessages', errors, '', true),
    handoffEnabled: bool(body, 'handoffEnabled', errors, '', false),
    handoffPauseMinutes: int(body, 'handoffPauseMinutes', errors, '', 0, 7 * 24 * 60),
    humanAgents,
  }
  if (errors.length) throw new ValidationError(errors)
  return input
}

export function parseEmail(v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!EMAIL.test(e) || e.length > 254) throw new ValidationError(['a valid email address is required'])
  return e
}

export function parseName(v: unknown, what = 'name'): string {
  const n = typeof v === 'string' ? v.trim() : ''
  if (!n || n.length > 80) throw new ValidationError([`${what} is required (max 80 characters)`])
  return n
}
