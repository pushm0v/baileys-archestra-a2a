// Small Web Crypto helpers: random tokens, hashing, and HMAC-signed values for cookies.

const enc = new TextEncoder()

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)))
}

export async function sha256Hex(input: string): Promise<string> {
  return [...await sha256(input)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Constant-time string comparison
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  if (x.byteLength !== y.byteLength) return false
  return crypto.subtle.timingSafeEqual(x, y)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

// "<payload>.<signature>", both base64url. Payloads must carry their own `exp` (ms since epoch).
export async function sign(value: object, secret: string): Promise<string> {
  const payload = base64url(enc.encode(JSON.stringify(value)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload))
  return `${payload}.${base64url(sig)}`
}

export async function verify<T extends { exp: number }>(token: string | undefined, secret: string, now = Date.now()): Promise<T | null> {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  let ok = false
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(sig), enc.encode(payload))
  } catch {
    return null
  }
  if (!ok) return null
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as T
    return typeof value.exp === 'number' && value.exp > now ? value : null
  } catch {
    return null
  }
}
