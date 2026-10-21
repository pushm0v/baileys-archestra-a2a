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
export type AppEnv = { Bindings: Env, Variables: { session: Session } }
type OAuthState = { state: string, verifier: string, nonce: string, exp: number }
type AppContext = Context<AppEnv>

const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

// ADMIN_EMAILS from wrangler.jsonc: comma- or space-separated
export function configAdmins(env: Env): string[] {
  return env.ADMIN_EMAILS.split(/[\s,]+/).map(e => e.trim().toLowerCase()).filter(Boolean)
}

export async function isAdmin(env: Env, email: string): Promise<boolean> {
  const e = email.toLowerCase()
  if (configAdmins(env).includes(e)) return true
  return Boolean(await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(e).first())
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
  }).toString()
  return c.redirect(url.toString())
}

export class LoginError extends Error {}

// Returns the verified Google account email
export async function finishLogin(c: AppContext): Promise<string> {
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
  return payload.email.toLowerCase()
}

export async function startSession(c: AppContext, email: string): Promise<void> {
  const session: Session = { email, exp: Date.now() + SESSION_TTL_MS }
  setCookie(c, SESSION_COOKIE, await sign(session, c.env.SESSION_SECRET), { ...cookieOptions, maxAge: SESSION_TTL_MS / 1000 })
}

export function endSession(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions)
}
