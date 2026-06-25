/**
 * Realizes docs/05-auth.md §2f/§6 — the safe-link token contract, proven vendor-free against Web Crypto.
 * Covers the round-trip, purpose binding, tamper/forgery rejection (bad MAC, wrong secret), live expiry, and
 * the never-throw failure surface (malformed input → a reason, not an exception).
 */
import { describe, it, expect } from 'vitest'
import { createSafeLinks } from '../safe-link'

/** A clock a test can move forward, to drive expiry deterministically. */
function mutableClock(startIso: string) {
  let t = new Date(startIso).getTime()
  return { now: () => new Date(t), advance: (ms: number) => { t += ms } }
}

const SECRET = 'a-very-secret-key-for-tests-only'

describe('createSafeLinks — round-trip + purpose binding (doc 05 §2f)', () => {
  it('mints a token that verifies back to the same claims', async () => {
    const clock = mutableClock('2026-06-25T08:00:00.000Z')
    const links = createSafeLinks({ secret: SECRET, clock, ids: { token: () => 'nonce-1', uuid: () => 'u' } })

    const token = await links.mint({ purpose: 'application.confirm', subject: 'app-7', data: { email: 'a@x.cz' }, ttlSeconds: 600 })
    const r = await links.verify<{ email: string }>(token)

    expect(r.valid).toBe(true)
    if (r.valid) {
      expect(r.claims.purpose).toBe('application.confirm')
      expect(r.claims.subject).toBe('app-7')
      expect(r.claims.data).toEqual({ email: 'a@x.cz' })
      expect(r.claims.nonce).toBe('nonce-1')
      expect(r.claims.exp - r.claims.iat).toBe(600)
    }
  })

  it('accepts a matching expected purpose and rejects a mismatched one', async () => {
    const links = createSafeLinks({ secret: SECRET })
    const token = await links.mint({ purpose: 'self-excuse', subject: 'enr-1' })
    expect((await links.verify(token, { purpose: 'self-excuse' })).valid).toBe(true)
    expect(await links.verify(token, { purpose: 'email.unsubscribe' })).toEqual({ valid: false, reason: 'purpose_mismatch' })
  })
})

describe('createSafeLinks — forgery & tamper rejection (doc 05 §6)', () => {
  it('rejects a tampered payload with bad_signature', async () => {
    const links = createSafeLinks({ secret: SECRET })
    const token = await links.mint({ purpose: 'p', subject: 's' })
    const [payload, sig] = token.split('.')
    // flip the last char of the payload segment to a different base64url char
    const lastChar = payload!.slice(-1)
    const tampered = payload!.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A')
    const forged = `${tampered}.${sig}`
    expect(await links.verify(forged)).toEqual({ valid: false, reason: 'bad_signature' })
  })

  it('rejects a token signed with a different secret', async () => {
    const a = createSafeLinks({ secret: SECRET })
    const b = createSafeLinks({ secret: 'a-completely-different-secret' })
    const token = await a.mint({ purpose: 'p', subject: 's' })
    expect(await b.verify(token)).toEqual({ valid: false, reason: 'bad_signature' })
  })

  it('returns malformed (never throws) for junk tokens', async () => {
    const links = createSafeLinks({ secret: SECRET })
    for (const junk of ['', 'garbage', 'a.b.c', 'onlyonesegment', '.', 'x.']) {
      const r = await links.verify(junk)
      expect(r.valid).toBe(false)
      if (!r.valid) expect(['malformed', 'bad_signature']).toContain(r.reason)
    }
  })
})

describe('createSafeLinks — expiry is live at verify (doc 08 §5 parallel)', () => {
  it('expires after ttlSeconds elapse', async () => {
    const clock = mutableClock('2026-06-25T08:00:00.000Z')
    const links = createSafeLinks({ secret: SECRET, clock })
    const token = await links.mint({ purpose: 'p', subject: 's', ttlSeconds: 60 })

    expect((await links.verify(token)).valid).toBe(true) // still inside the window
    clock.advance(61_000)
    expect(await links.verify(token)).toEqual({ valid: false, reason: 'expired' })
  })

  it('honours an explicit expiresAt in the past → expired immediately', async () => {
    const clock = mutableClock('2026-06-25T08:00:00.000Z')
    const links = createSafeLinks({ secret: SECRET, clock })
    const token = await links.mint({ purpose: 'p', subject: 's', expiresAt: new Date('2026-06-25T07:00:00.000Z') })
    expect(await links.verify(token)).toEqual({ valid: false, reason: 'expired' })
  })
})

describe('createSafeLinks — config guard', () => {
  it('throws if constructed without a secret', () => {
    expect(() => createSafeLinks({ secret: '' })).toThrow(/secret/)
  })
})
