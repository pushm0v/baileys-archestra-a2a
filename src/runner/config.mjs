// Turns a number's settings from the dashboard into the environment for its bridge process.
// Archestra tokens never leave the runner: the dashboard only names the env var that holds one.

import path from 'node:path'

export class ConfigError extends Error {}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

// Runner-only settings that its bridge processes must not see
const RUNNER_ONLY = ['DASHBOARD_URL', 'RUNNER_TOKEN', 'ROUTES_FILE']

function tokenName(env, name, where) {
  if (!ENV_NAME.test(name)) throw new ConfigError(`${where}: token env var name "${name}" is invalid`)
  if (!env[name]) throw new ConfigError(`${where}: env var ${name} is not set on this runner`)
  return name
}

/**
 * @param {object} number   settings for one WhatsApp number, as sent by the dashboard
 * @param {object} env      the runner's environment
 * @param {string} dataRoot directory holding one folder per number
 * @returns {Record<string,string>} environment for the bridge process
 */
export function bridgeEnv(number, env, dataRoot) {
  if (!ID_PATTERN.test(number.id ?? '')) throw new ConfigError(`invalid number id "${number.id}"`)
  const where = `number "${number.name || number.id}"`
  const url = number.archestraUrl || env.ARCHESTRA_URL
  if (!url) throw new ConfigError(`${where}: no Archestra URL (set one in the dashboard or ARCHESTRA_URL on the runner)`)
  if (!number.agentId) throw new ConfigError(`${where}: agent ID is required`)
  const defaultToken = tokenName(env, number.tokenRef || 'ARCHESTRA_TOKEN', where)

  // Route tokens become "env:NAME", which the bridge resolves from its own (inherited) environment
  const routes = {}
  for (const [key, r] of Object.entries(number.routes || {})) {
    const { tokenRef, ...rest } = r
    routes[key] = tokenRef ? { ...rest, token: `env:${tokenName(env, tokenRef, `${where} route "${key}"`)}` } : rest
  }

  const out = { ...env }
  for (const k of RUNNER_ONLY) delete out[k]
  return {
    ...out,
    ARCHESTRA_URL: url,
    ARCHESTRA_AGENT_ID: number.agentId,
    ARCHESTRA_TOKEN: env[defaultToken],
    ALLOWED_NUMBERS: (number.allowedNumbers || []).join(','),
    DATA_DIR: path.join(dataRoot, number.id),
    ROUTES_JSON: JSON.stringify(routes),
    ...(number.mediaTypes && { MEDIA_TYPES: number.mediaTypes.join(',') }),
    ...(number.maxMediaMb && { MAX_MEDIA_MB: String(number.maxMediaMb) }),
    ...(number.mediaInline && { MEDIA_INLINE: number.mediaInline }),
    ...(number.agentTimeoutMs && { AGENT_TIMEOUT_MS: String(number.agentTimeoutMs) }),
  }
}
