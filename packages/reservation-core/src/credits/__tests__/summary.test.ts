/**
 * summarizeCredits — the balance every surface shows. The load-bearing rules:
 *   • `available` uses isRedeemableNow semantics: active AND not past expiry (live — an active row whose
 *     expires_at passed does NOT count, even before any sweeper flips its status).
 *   • `nextExpiresAt` = soonest non-null expiry among AVAILABLE credits (never-expiring ones don't cap it).
 *   • `issued` excludes 'cancelled' (corrections aren't history); `redeemed` counts as issued AND redeemed.
 */
import { describe, it, expect } from 'vitest'
import { summarizeCredits, type CreditForSummary } from '../summary'

const NOW = new Date('2026-07-06T12:00:00.000Z')

function credit(overrides: Partial<CreditForSummary> = {}): CreditForSummary {
  return { status: 'active', expiresAt: null, ...overrides }
}

describe('summarizeCredits', () => {
  it('empty list → all zeroes', () => {
    expect(summarizeCredits([], NOW)).toEqual({ available: 0, nextExpiresAt: null, issued: 0, redeemed: 0 })
  })

  it('counts active credits with future or no expiry as available', () => {
    const s = summarizeCredits(
      [credit({ expiresAt: new Date('2026-08-01') }), credit({ expiresAt: null })],
      NOW,
    )
    expect(s.available).toBe(2)
    expect(s.issued).toBe(2)
  })

  it("an 'active' credit whose expiry already PASSED is not available (live evaluation), but still issued", () => {
    const s = summarizeCredits([credit({ expiresAt: new Date('2026-07-01') })], NOW)
    expect(s.available).toBe(0)
    expect(s.issued).toBe(1)
    expect(s.nextExpiresAt).toBeNull() // expired credits never cap the "use by" date
  })

  it('expiry is INCLUSIVE — a credit expiring exactly now still counts (isRedeemableNow parity)', () => {
    const s = summarizeCredits([credit({ expiresAt: NOW })], NOW)
    expect(s.available).toBe(1)
    expect(s.nextExpiresAt).toEqual(NOW)
  })

  it('nextExpiresAt = the SOONEST expiry among available credits; null-expiry credits do not cap it', () => {
    const s = summarizeCredits(
      [
        credit({ expiresAt: new Date('2026-09-01') }),
        credit({ expiresAt: new Date('2026-08-01') }), // soonest
        credit({ expiresAt: null }),
      ],
      NOW,
    )
    expect(s.available).toBe(3)
    expect(s.nextExpiresAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it("redeemed counts toward issued + redeemed, never available; 'expired' status is issued only", () => {
    const s = summarizeCredits(
      [credit({ status: 'redeemed' }), credit({ status: 'expired' }), credit()],
      NOW,
    )
    expect(s).toEqual({ available: 1, nextExpiresAt: null, issued: 3, redeemed: 1 })
  })

  it("'cancelled' credits are invisible everywhere (not issued, not available)", () => {
    const s = summarizeCredits([credit({ status: 'cancelled' })], NOW)
    expect(s).toEqual({ available: 0, nextExpiresAt: null, issued: 0, redeemed: 0 })
  })
})
