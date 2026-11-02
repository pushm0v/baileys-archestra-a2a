// Sign-in providers: Google, and Zitadel (any OpenID Connect issuer, found through discovery).
// Both use the authorization code flow with PKCE, a nonce and the same /auth/callback.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { ROLES, type Role } from './roles'

export type ProviderId = 'google' | 'zitadel'
export type ProviderInfo = { id: ProviderId, label: string }

export class LoginError extends Error {}

// What a provider tells us about the person once the callback is verified
export type Identity = {
  provider: ProviderId
  email: string
  // Google Workspace domain (hd claim), checked against ALLOWED_DOMAINS
  hd: string | null
  // Zitadel project roles, by name
  roles: string[]
}

type Endpoints = { issuer: string, authorization_endpoint: string, token_endpoint: string, jwks_uri: string, userinfo_endpoint?: string }

const GOOGLE: Endpoints = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
}
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

// Asks Zitadel to put the user's project roles in the tokens
export const ZITADEL_SCOPES = 'openid email profile urn:zitadel:iam:org:projects:roles'
const ZITADEL_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles'
const ZITADEL_PROJECT_ROLES = /^urn:zitadel:iam:org:project:[^:]+:roles$/

const trimSlash = (s: string) => s.replace(/\/+$/, '')

export function configuredProviders(env: Env): ProviderInfo[] {
  const out: ProviderInfo[] = []
  if (env.GOOGLE_CLIENT_ID) out.push({ id: 'google', label: 'Google' })
  if (env.ZITADEL_ISSUER && env.ZITADEL_CLIENT_ID) out.push({ id: 'zitadel', label: env.ZITADEL_LABEL || 'Zitadel' })
  return out
}

// ---------- Discovery and keys (cached for the life of the isolate) ----------

const discovery = new Map<string, { doc: Endpoints, at: number }>()
const DISCOVERY_TTL_MS = 60 * 60 * 1000

async function zitadelEndpoints(env: Env): Promise<Endpoints> {
  const issuer = trimSlash(env.ZITADEL_ISSUER)
  const hit = discovery.get(issuer)
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } })
  const doc = await res.json<Partial<Endpoints>>().catch(() => null)
  if (!res.ok || !doc?.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
    throw new LoginError(`Could not read Zitadel's sign-in settings from ${issuer} (HTTP ${res.status}). Check ZITADEL_ISSUER.`)
  }
  // The discovery document must be about the issuer we were told to trust
  if (trimSlash(doc.issuer) !== issuer) throw new LoginError(`Zitadel reports issuer ${doc.issuer}, but ZITADEL_ISSUER is ${issuer}`)
  discovery.set(issuer, { doc: doc as Endpoints, at: Date.now() })
  return doc as Endpoints
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
function keysFor(jwksUri: string) {
  let keys = keySets.get(jwksUri)
  if (!keys) { keys = createRemoteJWKSet(new URL(jwksUri)); keySets.set(jwksUri, keys) }
  return keys
}

// ---------- Starting sign-in ----------

export type AuthParams = { redirectUri: string, state: string, nonce: string, codeChallenge: string, hd: string | null }

export async function authorizationUrl(env: Env, provider: ProviderId, p: AuthParams): Promise<string> {
  const common = {
    redirect_uri: p.redirectUri,
    response_type: 'code',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    // Lets people switch accounts instead of silently reusing another session (e.g. an admin's)
    prompt: 'select_account',
  }
  if (provider === 'google') {
    const url = new URL(GOOGLE.authorization_endpoint)
    url.search = new URLSearchParams({ ...common, client_id: env.GOOGLE_CLIENT_ID, scope: 'openid email', ...(p.hd && { hd: p.hd }) }).toString()
    return url.toString()
  }
  const ep = await zitadelEndpoints(env)
  const url = new URL(ep.authorization_endpoint)
  url.search = new URLSearchParams({ ...common, client_id: env.ZITADEL_CLIENT_ID, scope: ZITADEL_SCOPES }).toString()
  return url.toString()
}

// ---------- Finishing sign-in ----------

// Token request for the code. With a client secret, Zitadel's default "Basic" method is used;
// without one, the app is a public client that proves itself with PKCE alone.
export function tokenRequest(o: { clientId: string, clientSecret?: string, code: string, redirectUri: string, verifier: string, basicAuth: boolean }): RequestInit {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (o.clientSecret && o.basicAuth) {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`)}`
  } else {
    form.set('client_id', o.clientId)
    if (o.clientSecret) form.set('client_secret', o.clientSecret)
  }
  return { method: 'POST', headers, body: form }
}

type TokenResponse = { id_token?: string, access_token?: string, error?: string, error_description?: string }

async function exchange(url: string, init: RequestInit, label: string): Promise<TokenResponse & { id_token: string }> {
  const res = await fetch(url, init)
  const body = await res.json<TokenResponse>().catch(() => null)
  if (!res.ok || !body?.id_token) throw new LoginError(`${label} token exchange failed: ${body?.error_description || body?.error || res.status}`)
  return body as TokenResponse & { id_token: string }
}

function checkNonce(payload: JWTPayload, nonce: string, safeEqual: (a: string, b: string) => boolean) {
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, nonce)) throw new LoginError('Sign-in response did not match this request')
}

// Role names from Zitadel's role claims: { "<role>": { "<orgId>": "<org domain>" } }
export function zitadelRoles(claims: Record<string, unknown>): string[] {
  const names = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [])
  let roles = names(claims[ZITADEL_ROLES_CLAIM])
  // Some setups only send the project-specific claim
  if (!roles.length) roles = Object.entries(claims).filter(([k]) => ZITADEL_PROJECT_ROLES.test(k)).flatMap(([, v]) => names(v))
  return [...new Set(roles)]
}

export async function finishSignIn(env: Env, provider: ProviderId, o: { code: string, redirectUri: string, verifier: string, nonce: string, safeEqual: (a: string, b: string) => boolean }): Promise<Identity> {
  if (provider === 'google') {
    const tokens = await exchange(GOOGLE.token_endpoint, tokenRequest({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, code: o.code, redirectUri: o.redirectUri, verifier: o.verifier, basicAuth: false }), 'Google')
    const { payload } = await jwtVerify(tokens.id_token, keysFor(GOOGLE.jwks_uri), { issuer: GOOGLE_ISSUERS, audience: env.GOOGLE_CLIENT_ID })
    checkNonce(payload, o.nonce, o.safeEqual)
    if (typeof payload.email !== 'string' || payload.email_verified !== true) throw new LoginError('Your Google account email is not verified')
    return { provider, email: payload.email.toLowerCase(), hd: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null, roles: [] }
  }

  const ep = await zitadelEndpoints(env)
  const tokens = await exchange(ep.token_endpoint, tokenRequest({ clientId: env.ZITADEL_CLIENT_ID, clientSecret: env.ZITADEL_CLIENT_SECRET, code: o.code, redirectUri: o.redirectUri, verifier: o.verifier, basicAuth: true }), 'Zitadel')
  const { payload } = await jwtVerify(tokens.id_token, keysFor(ep.jwks_uri), { issuer: ep.issuer, audience: env.ZITADEL_CLIENT_ID })
  checkNonce(payload, o.nonce, o.safeEqual)

  // Zitadel only puts email and roles in the ID token when the app is set to; otherwise they come from userinfo
  let claims: Record<string, unknown> = { ...payload }
  const needsUserinfo = typeof claims.email !== 'string' || !zitadelRoles(claims).length
  if (needsUserinfo && ep.userinfo_endpoint && tokens.access_token) {
    const res = await fetch(ep.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } })
    const info = res.ok ? await res.json<Record<string, unknown>>().catch(() => null) : null
    // Userinfo must describe the same person as the ID token
    if (info && info.sub === payload.sub) {
      if (typeof claims.email !== 'string') claims = { ...claims, email: info.email, email_verified: info.email_verified }
      if (!zitadelRoles(claims).length) claims = { ...claims, ...pickRoleClaims(info) }
    }
  }
  if (typeof claims.email !== 'string') throw new LoginError('Zitadel did not share your email address. Ask an admin to check that the app requests the "email" scope.')
  if (claims.email_verified !== true) throw new LoginError('Your Zitadel account email is not verified. Verify it in Zitadel, then sign in again.')
  return { provider, email: claims.email.toLowerCase(), hd: null, roles: zitadelRoles(claims) }
}

function pickRoleClaims(info: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(info).filter(([k]) => k === ZITADEL_ROLES_CLAIM || ZITADEL_PROJECT_ROLES.test(k)))
}

// ---------- Zitadel roles → dashboard role ----------

// ZITADEL_ROLE_MAPPING, e.g. "admin=wa-admin, operator=wa-operator, viewer=wa-viewer, viewer=staff".
// Empty means Zitadel roles are ignored and roles are managed on the Users page as for Google.
export function parseRoleMapping(text: string | undefined): Map<string, Role> | null {
  const pairs = (text ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  if (!pairs.length) return null
  const map = new Map<string, Role>()
  for (const pair of pairs) {
    const [role, zitadelRole] = pair.split('=').map(s => s?.trim())
    if (!(ROLES as readonly string[]).includes(role) || !zitadelRole) throw new Error(`ZITADEL_ROLE_MAPPING: "${pair}" must look like admin=<zitadel role> (roles: ${ROLES.join(', ')})`)
    // A Zitadel role listed twice keeps the higher dashboard role
    const prev = map.get(zitadelRole)
    if (!prev || ROLES.indexOf(role as Role) > ROLES.indexOf(prev)) map.set(zitadelRole, role as Role)
  }
  return map
}

// The highest dashboard role the person's Zitadel roles give them, or null
export function mappedRole(mapping: Map<string, Role>, roles: string[]): Role | null {
  let best: Role | null = null
  for (const r of roles) {
    const role = mapping.get(r)
    if (role && (!best || ROLES.indexOf(role) > ROLES.indexOf(best))) best = role
  }
  return best
}
