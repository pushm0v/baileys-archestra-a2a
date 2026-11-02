import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { ORIGIN, worker, call } from './helpers'
import { parseRoleMapping, mappedRole, zitadelRoles, tokenRequest, ZITADEL_SCOPES } from '../src/providers'

const ISSUER = 'https://auth.example.com'
const ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles'
const roleClaim = (...roles: string[]) => Object.fromEntries(roles.map(r => [r, { '2843': 'example.com' }]))

afterEach(() => { vi.restoreAllMocks() })

describe('Zitadel sign-in', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>
  let jwk: Record<string, unknown>
  beforeAll(async () => {
    keys = await generateKeyPair('RS256')
    jwk = { ...await exportJWK(keys.publicKey), kid: 'zitadel-key', alg: 'RS256', use: 'sig' }
  })

  // Fake Zitadel: discovery, token, keys and userinfo
  function fakeZitadel({ idClaims, userinfo, onToken }: { idClaims: () => Promise<Record<string, unknown>>, userinfo?: Record<string, unknown>, onToken?: (req: { auth: string | null, form: URLSearchParams }) => void }) {
    const realFetch = globalThis.fetch
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init)
      if (req.url === `${ISSUER}/.well-known/openid-configuration`) {
        return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/v2/authorize`, token_endpoint: `${ISSUER}/oauth/v2/token`,
          jwks_uri: `${ISSUER}/oauth/v2/keys`, userinfo_endpoint: `${ISSUER}/oidc/v1/userinfo` })
      }
      if (req.url === `${ISSUER}/oauth/v2/keys`) return Response.json({ keys: [jwk] })
      if (req.url === `${ISSUER}/oauth/v2/token`) {
        onToken?.({ auth: req.headers.get("Authorization"), form: new URLSearchParams(await req.clone().text()) })
        const claims = await idClaims()
        const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'zitadel-key' })
          .setIssuer(ISSUER).setAudience('zitadel-client').setSubject('zitadel-user-1').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
        return Response.json({ id_token: idToken, access_token: 'access-1', token_type: 'Bearer' })
      }
      if (req.url === `${ISSUER}/oidc/v1/userinfo`) {
        expect(req.headers.get('Authorization')).toBe('Bearer access-1')
        return Response.json({ sub: 'zitadel-user-1', ...userinfo })
      }
      return realFetch(input, init)
    })
  }

  async function signIn(claims: Record<string, unknown>, opts: { userinfo?: Record<string, unknown>, onToken?: (req: { auth: string | null, form: URLSearchParams }) => void, nonce?: string } = {}) {
    let authorizeUrl: URL | undefined
    fakeZitadel({ idClaims: async () => ({ nonce: opts.nonce ?? authorizeUrl!.searchParams.get('nonce'), ...claims }), userinfo: opts.userinfo, onToken: opts.onToken })
    const start = await call('GET', '/auth/login/zitadel', { email: null })
    expect(start.status).toBe(302)
    authorizeUrl = new URL(start.headers.get('Location')!)
    const oauthCookie = start.headers.get('Set-Cookie')!.split(';')[0]
    return worker.fetch(`${ORIGIN}/auth/callback?code=zcode&state=${authorizeUrl.searchParams.get('state')}`, { headers: { Cookie: oauthCookie }, redirect: 'manual' })
  }

  const sessionOf = (res: Response) => res.headers.get('Set-Cookie')!.match(/__Host-session=[^;]+/)![0]
  const me = async (res: Response) => (await worker.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: sessionOf(res) } })).json()

  it('lists both providers on the login page', async () => {
    const res = await worker.fetch(`${ORIGIN}/login`)
    const html = await res.text()
    expect(html).toContain('href="/auth/login/google"')
    expect(html).toContain('href="/auth/login/zitadel"')
    expect(html).toContain('Sign in with Example SSO')
    // With two providers, the bare /auth/login shows the choice
    expect((await worker.fetch(`${ORIGIN}/auth/login`, { redirect: 'manual' })).headers.get('Location')).toBe('/login')
    expect((await worker.fetch(`${ORIGIN}/auth/login/github`, { redirect: 'manual' })).status).toBe(404)
  })

  it('starts the code flow from the discovery document, with PKCE and the roles scope', async () => {
    fakeZitadel({ idClaims: async () => ({}) })
    const res = await call('GET', '/auth/login/zitadel', { email: null })
    const url = new URL(res.headers.get('Location')!)
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth/v2/authorize`)
    expect(url.searchParams.get('client_id')).toBe('zitadel-client')
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`)
    expect(url.searchParams.get('scope')).toBe(ZITADEL_SCOPES)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('prompt')).toBe('select_account')
  })

  it('signs in with a mapped Zitadel role, using Basic client auth', async () => {
    let tokenReq: { auth: string | null, form: URLSearchParams } | undefined
    const res = await signIn({ email: 'Rina@example.com', email_verified: true, [ROLES_CLAIM]: roleClaim('wa-operator', 'staff') }, { onToken: r => { tokenReq = r } })
    expect(res.status).toBe(302)
    expect(await me(res)).toEqual({ email: 'rina@example.com', role: 'operator' })
    expect(tokenReq!.auth).toBe(`Basic ${btoa('zitadel-client:zitadel-secret')}`)
    const form = tokenReq!.form
    expect(form.get('code')).toBe('zcode')
    expect(form.get('code_verifier')).toBeTruthy()
    expect(form.get('client_secret')).toBeNull()

    const { users } = await (await call('GET', '/api/users')).json<any>()
    expect(users.find((u: any) => u.email === 'rina@example.com')).toMatchObject({ role: 'operator', updatedBy: 'zitadel' })

    // Losing the role in Zitadel takes access away at the next sign-in
    const again = await signIn({ email: 'rina@example.com', email_verified: true, [ROLES_CLAIM]: roleClaim('other') })
    expect(again.status).toBe(403)
    expect(await again.text()).toContain('none of the roles')
    expect((await call('GET', '/api/users')).ok).toBe(true)
    const after = (await (await call('GET', '/api/users')).json<any>()).users.find((u: any) => u.email === 'rina@example.com')
    expect(after.role).toBeNull()
  })

  it('reads email and roles from userinfo when the ID token leaves them out', async () => {
    const res = await signIn({}, { userinfo: { email: 'budi@example.com', email_verified: true, 'urn:zitadel:iam:org:project:2843:roles': roleClaim('wa-admin') } })
    expect(res.status).toBe(302)
    expect(await me(res)).toEqual({ email: 'budi@example.com', role: 'admin' })
  })

  it('ignores userinfo for a different subject', async () => {
    const res = await signIn({}, { userinfo: { sub: 'someone-else', email: 'boss@example.com', email_verified: true } })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('did not share your email')
  })

  it('refuses unverified emails, other domains and replayed tokens', async () => {
    const unverified = await signIn({ email: 'x@example.com', email_verified: false, [ROLES_CLAIM]: roleClaim('wa-viewer') })
    expect(unverified.status).toBe(400)
    expect(await unverified.text()).toContain('not verified')

    const outside = await signIn({ email: 'x@other.com', email_verified: true, [ROLES_CLAIM]: roleClaim('wa-admin') })
    expect(outside.status).toBe(403)
    expect(await outside.text()).toContain('Only @example.com')

    expect((await signIn({ email: 'x@example.com', email_verified: true }, { nonce: 'forged' })).status).toBe(400)
  })

  it('lets default admins in without a Zitadel role', async () => {
    const res = await signIn({ email: 'boss@example.com', email_verified: true })
    expect(res.status).toBe(302)
    expect(await me(res)).toEqual({ email: 'boss@example.com', role: 'admin' })
  })
})

describe('Zitadel helpers', () => {
  it('maps Zitadel roles to the highest dashboard role', () => {
    const map = parseRoleMapping('admin=wa-admin, operator=wa-ops viewer=staff viewer=wa-ops')!
    expect(map.get('wa-ops')).toBe('operator')
    expect(mappedRole(map, ['staff'])).toBe('viewer')
    expect(mappedRole(map, ['staff', 'wa-admin'])).toBe('admin')
    expect(mappedRole(map, ['nobody'])).toBeNull()
    expect(parseRoleMapping('')).toBeNull()
    expect(() => parseRoleMapping('owner=x')).toThrow(/must look like/)
    expect(() => parseRoleMapping('admin')).toThrow(/must look like/)
  })

  it('reads role names from the generic or project-specific claim', () => {
    expect(zitadelRoles({ [ROLES_CLAIM]: roleClaim('a', 'b') })).toEqual(['a', 'b'])
    expect(zitadelRoles({ 'urn:zitadel:iam:org:project:1:roles': roleClaim('a'), 'urn:zitadel:iam:org:project:2:roles': roleClaim('a', 'c') })).toEqual(['a', 'c'])
    expect(zitadelRoles({ [ROLES_CLAIM]: ['not', 'an', 'object'] })).toEqual([])
  })

  it('sends the client ID in the form for a PKCE-only app', async () => {
    const init = tokenRequest({ clientId: 'c', code: 'x', redirectUri: 'r', verifier: 'v', basicAuth: true })
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(new URLSearchParams(String(init.body)).get('client_id')).toBe('c')
  })
})
