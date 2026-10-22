// Google sign-in (OpenID Connect authorization code flow with PKCE) and session cookies.

import { createRemoteJWKSet, jwtVerify } from 'jose'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { base64url, randomToken, sha256, sign, verify, safeEqual } from './crypto'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
// Google's signing keys; jose caches them for the life of the isolate
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

export const SESSION_COOKIE = '__Host-session'
const OAUTH_COOKIE = '__Host-oauth'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const OAUTH_TTL_MS = 10 * 60 * 1000

export type Session = { email: string, exp: number }
export type AppEnv = { Bindings: Env, Variables: { session: Session, role: Role } }
type OAuthState = { state: string, verifier: string, nonce: string, exp: number }
type AppContext = Context<AppEnv>

const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

// ---------- Roles ----------

// Lowest to highest; each role can do everything the ones before it can
export const ROLES = ['viewer', 'operator', 'admin'] as const
export type Role = (typeof ROLES)[number]
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)
export const atLeast = (role: Role, min: Role) => ROLES.indexOf(role) >= ROLES.indexOf(min)

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

const redirectUri = (c: AppContext) => `${new URL(c.req.url).origin}/auth/callback`

export async function startLogin(c: AppContext): Promise<Response> {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text('GOOGLE_CLIENT_ID is not set in wrangler.jsonc', 500)
  const st: OAuthState = { state: randomToken(), verifier: randomToken(48), nonce: randomToken(), exp: Date.now() + OAUTH_TTL_MS }
  setCookie(c, OAUTH_COOKIE, await sign(st, c.env.SESSION_SECRET), { ...cookieOptions, maxAge: OAUTH_TTL_MS / 1000 })
  const url = new URL(GOOGLE_AUTH_URL)
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email',
    state: st.state,
    nonce: st.nonce,
    code_challenge: base64url(await sha256(st.verifier)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    // With a single Workspace domain, Google only offers accounts from it
    ...(hdHint(c.env) && { hd: hdHint(c.env)! }),
  }).toString()
  return c.redirect(url.toString())
}

function hdHint(env: Env): string | null {
  const domains = allowedDomains(env)
  return domains.length === 1 && !CONSUMER_DOMAINS.has(domains[0]) ? domains[0] : null
}

export class LoginError extends Error {}

// Returns the verified Google account email, and its Workspace domain (hd) if it has one
export async function finishLogin(c: AppContext): Promise<{ email: string, hd: string | null }> {
  const st = await verify<OAuthState>(getCookie(c, OAUTH_COOKIE), c.env.SESSION_SECRET)
  deleteCookie(c, OAUTH_COOKIE, cookieOptions)
  const { code, state, error } = c.req.query()
  if (error) throw new LoginError(`Google sign-in was cancelled (${error})`)
  if (!st || !state || !safeEqual(state, st.state)) throw new LoginError('Sign-in expired or was started in another tab. Please try again.')
  if (!code) throw new LoginError('Google did not return an authorization code')

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
      code_verifier: st.verifier,
    }),
  })
  const body = await res.json<{ id_token?: string, error?: string, error_description?: string }>().catch(() => null)
  if (!res.ok || !body?.id_token) throw new LoginError(`Google token exchange failed: ${body?.error_description || body?.error || res.status}`)

  const { payload } = await jwtVerify(body.id_token, googleKeys, { issuer: GOOGLE_ISSUERS, audience: c.env.GOOGLE_CLIENT_ID })
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, st.nonce)) throw new LoginError('Sign-in response did not match this request')
  if (typeof payload.email !== 'string' || payload.email_verified !== true) throw new LoginError('Your Google account email is not verified')
  return { email: payload.email.toLowerCase(), hd: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null }
}

export async function startSession(c: AppContext, email: string): Promise<void> {
  const session: Session = { email, exp: Date.now() + SESSION_TTL_MS }
  setCookie(c, SESSION_COOKIE, await sign(session, c.env.SESSION_SECRET), { ...cookieOptions, maxAge: SESSION_TTL_MS / 1000 })
}

export function endSession(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions)
}
