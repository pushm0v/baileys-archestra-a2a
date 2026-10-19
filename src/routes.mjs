// Chat -> Archestra agent routing, and group mention handling.
//
// Routes file (JSON), keyed by WhatsApp group JID or by phone number for direct chats:
// {
//   "120363041234567890@g.us": { "name": "ops", "agentId": "…" },
//   "120363049876543210@g.us": { "agentId": "…", "url": "https://other", "token": "env:SALES_TOKEN",
//                                 "trigger": "all", "allowedNumbers": ["6281234567890"] },
//   "6281234567890":            { "agentId": "…" }
// }

import fs from 'node:fs'

const TRIGGERS = ['mention', 'all']

export class RoutesError extends Error {}

// "62812:5@s.whatsapp.net" / "1217…:5@lid" -> "62812" / "1217…"
export const userOf = jid => String(jid).split('@')[0].split(':')[0]

/**
 * Validate a parsed routes object and fill in defaults.
 * @param {object} raw     parsed JSON
 * @param {object} o
 * @param {string} o.url   default Archestra URL
 * @param {string} o.token default Archestra token
 * @param {object} o.env   environment, for "env:NAME" tokens
 * @returns {Map<string, {key, name, agentId, url, token, trigger, allowedNumbers: Set<string>|null, isGroup}>}
 */
export function parseRoutes(raw, { url, token, env = {} }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RoutesError('routes must be a JSON object keyed by group JID or phone number')
  const routes = new Map()
  for (const [key, r] of Object.entries(raw)) {
    const isGroup = key.endsWith('@g.us')
    const where = `route "${key}"`
    if (!isGroup && !/^\d+$/.test(key)) throw new RoutesError(`${where}: key must be a group JID (…@g.us) or a phone number (digits only, country code, no +)`)
    if (!r || typeof r !== 'object') throw new RoutesError(`${where}: must be an object`)
    if (!r.agentId) throw new RoutesError(`${where}: agentId is required`)
    const trigger = r.trigger ?? 'mention'
    if (!TRIGGERS.includes(trigger)) throw new RoutesError(`${where}: trigger must be ${TRIGGERS.join(' or ')}`)
    if (r.allowedNumbers !== undefined && !Array.isArray(r.allowedNumbers)) throw new RoutesError(`${where}: allowedNumbers must be a list`)

    let routeToken = r.token ?? token
    if (typeof routeToken === 'string' && routeToken.startsWith('env:')) {
      const name = routeToken.slice(4)
      routeToken = env[name]
      if (!routeToken) throw new RoutesError(`${where}: token refers to env var ${name}, which is not set`)
    }

    routes.set(key, {
      key,
      name: r.name || key,
      agentId: String(r.agentId),
      url: String(r.url ?? url).replace(/\/$/, ''),
      token: routeToken,
      trigger,
      allowedNumbers: r.allowedNumbers?.length ? new Set(r.allowedNumbers.map(String)) : null,
      isGroup,
    })
  }
  return routes
}

export function loadRoutes(file, opts) {
  if (!file || !fs.existsSync(file)) return new Map()
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new RoutesError(`${file}: invalid JSON (${e.message})`) }
  try { return parseRoutes(raw, opts) } catch (e) { throw new RoutesError(`${file}: ${e.message}`) }
}

// The bot can be mentioned by its phone number or by its LID, depending on the client
export const botIds = user => [user?.id, user?.lid].filter(Boolean).map(userOf)

export const isMentioned = (mentions = [], ids) => mentions.some(j => ids.includes(userOf(j)))

// Remove "@<bot>" tokens so the agent sees just the request
export function stripMentions(text, ids) {
  if (!text || !ids.length) return text
  return text.replace(new RegExp(`@(?:${ids.join('|')})\\b`, 'g'), '').replace(/\s{2,}/g, ' ').trim()
}
