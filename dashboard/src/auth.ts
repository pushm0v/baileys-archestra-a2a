// Sign-in (Google or Zitadel, see providers.ts), domain and role rules, and session cookies.

import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { base64url, randomToken, sha256, sign, verify, safeEqual } from './crypto'
import { authorizationUrl, configuredProviders, finishSignIn, LoginError, type Identity, type ProviderId } from './providers'
import { ROLES, isRole, atLeast, type Role } from './roles'

export { ROLES, isRole, atLeast, type Role, LoginError, type Identity }

export const SESSION_COOKIE = '__Host-session'
const OAUTH_COOKIE = '__Host-oauth'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const OAUTH_TTL_MS = 10 * 60 * 1000

export type Session = { email: string, exp: number }
export type AppEnv = { Bindings: Env, Variables: { session: Session, role: Role } }
type OAuthState = { provider: ProviderId, state: string, verifier: string, nonce: string, exp: number }
type AppContext = Context<AppEnv>

const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

// ---------- Domains and roles ----------

const list = (v: string | undefined) => (v ?? '').split(/[\s,]+/).map(e => e.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)

// ADMIN_EMAILS from wrangler.jsonc: comma- or space-separated
export function configAdmins(env: Env): string[] {
  return list(env.ADMIN_EMAILS)
}

// ALLOWED_DOMAINS from wrangler.jsonc. Empty means any domain, but then only invited users can sign in.
export function allowedDomains(env: Env): string[] {
  return list(env.ALLOWED_DOMAINS)
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

export function domainAllowed(env: Env, email: string): boolean {
  const domains = allowedDomains(env)
  return !domains.length || domains.includes(domainOf(email))
}

// Personal Google accounts: these have no hosted-domain (hd) claim
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

// At sign-in, a Workspace domain must also match Google's hd claim. Without it, a personal Google
// account registered with a work address (e.g. someone@company.com) would pass the email check.
export function loginDomainAllowed(env: Env, email: string, hd: string | null): boolean {
  if (!allowedDomains(env).length) return true
  if (!domainAllowed(env, email)) return false
  const domain = domainOf(email)
  return CONSUMER_DOMAINS.has(domain) ? !hd : hd === domain
}

// The user's current role, or null for no access. Checked on every request, so changes apply at once.
export async function roleOf(env: Env, email: string): Promise<Role | null> {
  const e = email.toLowerCase()
  if (configAdmins(env).includes(e)) return 'admin'
  if (!domainAllowed(env, e)) return null
  const row = await env.DB.prepare('SELECT role FROM users WHERE email = ?').bind(e).first<{ role: string | null }>()
  return isRole(row?.role) ? row.role : null
}

export async function readSession(c: AppContext): Promise<Session | null> {
  return verify<Session>(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET)
}

// ---------- Sign-in ----------

// One callback for every provider; the provider is remembered in the signed OAuth cookie
const redirectUri = (c: AppContext) => `${new URL(c.req.url).origin}/auth/callback`

// With a single Workspace domain, Google only offers accounts from it
function hdHint(env: Env): string | null {
  const domains = allowedDomains(env)
  return domains.length === 1 && !CONSUMER_DOMAINS.has(domains[0]) ? domains[0] : null
}

export async function startLogin(c: AppContext, provider: ProviderId): Promise<Response> {
  const st: OAuthState = { provider, state: randomToken(), verifier: randomToken(48), nonce: randomToken(), exp: Date.now() + OAUTH_TTL_MS }
  const url = await authorizationUrl(c.env, provider, {
    redirectUri: redirectUri(c), state: st.state, nonce: st.nonce,
    codeChallenge: base64url(await sha256(st.verifier)), hd: hdHint(c.env),
  })
  setCookie(c, OAUTH_COOKIE, await sign(st, c.env.SESSION_SECRET), { ...cookieOptions, maxAge: OAUTH_TTL_MS / 1000 })
  return c.redirect(url)
}

export const providerLabel = (env: Env, id: ProviderId | undefined) => configuredProviders(env).find(p => p.id === id)?.label ?? 'Sign-in'

// Verifies the callback and returns who signed in. The provider comes from our own signed
// cookie, never from the callback URL.
export async function finishLogin(c: AppContext): Promise<Identity> {
  const st = await verify<OAuthState>(getCookie(c, OAUTH_COOKIE), c.env.SESSION_SECRET)
  deleteCookie(c, OAUTH_COOKIE, cookieOptions)
  const { code, state, error } = c.req.query()
  const label = providerLabel(c.env, st?.provider)
  if (error) throw new LoginError(`${label} sign-in was cancelled (${error})`)
  if (!st || !state || !safeEqual(state, st.state)) throw new LoginError('Sign-in expired or was started in another tab. Please try again.')
  if (!configuredProviders(c.env).some(p => p.id === st.provider)) throw new LoginError(`${label} sign-in is not enabled`)
  if (!code) throw new LoginError(`${label} did not return an authorization code`)
  return finishSignIn(c.env, st.provider, { code, redirectUri: redirectUri(c), verifier: st.verifier, nonce: st.nonce, safeEqual })
}

export async function startSession(c: AppContext, email: string): Promise<void> {
  const session: Session = { email, exp: Date.now() + SESSION_TTL_MS }
  setCookie(c, SESSION_COOKIE, await sign(session, c.env.SESSION_SECRET), { ...cookieOptions, maxAge: SESSION_TTL_MS / 1000 })
}

export function endSession(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions)
}
