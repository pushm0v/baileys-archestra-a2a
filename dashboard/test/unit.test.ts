import { describe, it, expect } from 'vitest'
import { sign, verify, safeEqual, sha256Hex } from '../src/crypto'
import { parseNumber, parseEmail, ValidationError } from '../src/validate'

describe('signed values', () => {
  it('round-trips and rejects tampering, wrong keys and expiry', async () => {
    const token = await sign({ email: 'a@b.c', exp: Date.now() + 60_000 }, 'k1')
    expect(await verify(token, 'k1')).toMatchObject({ email: 'a@b.c' })
    expect(await verify(token, 'k2')).toBeNull()
    const [payload, sig] = token.split('.')
    const forged = btoa(JSON.stringify({ email: 'evil@x.y', exp: Date.now() + 60_000 })).replace(/=+$/, '')
    expect(await verify(`${forged}.${sig}`, 'k1')).toBeNull()
    expect(await verify(`${payload}.`, 'k1')).toBeNull()
    expect(await verify('garbage', 'k1')).toBeNull()
    const expired = await sign({ email: 'a@b.c', exp: Date.now() - 1 }, 'k1')
    expect(await verify(expired, 'k1')).toBeNull()
  })

  it('compares and hashes', async () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('number validation', () => {
  const base = { name: 'Support', agentId: 'agent-1' }

  it('fills defaults', () => {
    const n = parseNumber(base)
    expect(n).toMatchObject({ name: 'Support', enabled: true, runnerId: null, allowedNumbers: [], routes: [], tokenRef: null })
  })

  it('normalizes phone lists and routes', () => {
    const n = parseNumber({ ...base, allowedNumbers: ['+6281234', '6281234', ' 628912 '], archestraUrl: 'https://a.example.com/',
      routes: [{ key: '1203@g.us', agentId: 'x', allowedNumbers: ['6281234'] }] })
    expect(n.allowedNumbers).toEqual(['6281234', '628912'])
    expect(n.archestraUrl).toBe('https://a.example.com')
    expect(n.routes[0]).toMatchObject({ key: '1203@g.us', trigger: 'mention', allowedNumbers: ['6281234'] })
  })

  it('reports every problem at once', () => {
    try {
      parseNumber({ name: '', tokenRef: 'lower-case', archestraUrl: 'ftp://x', mediaTypes: ['gif'], mediaInline: 'sometimes',
        routes: [{ key: 'not a key', agentId: 'x' }, { key: '62812', agentId: 'y' }, { key: '62812', agentId: 'z', trigger: 'loud' }] })
      expect.unreachable()
    } catch (e) {
      const errors = (e as ValidationError).errors.join('\n')
      for (const part of ['name is required', 'agentId is required', 'env var name', 'http(s) URL', 'mediaTypes', 'mediaInline', 'route 1: key', 'route 3: trigger', 'duplicate route keys: 62812']) {
        expect(errors).toContain(part)
      }
    }
  })

  it('validates emails', () => {
    expect(parseEmail(' Admin@Example.COM ')).toBe('admin@example.com')
    expect(() => parseEmail('nope')).toThrow(ValidationError)
  })
})
