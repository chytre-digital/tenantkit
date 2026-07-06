/**
 * Credit balance summary — PURE. The one number every surface shows ("kolik mám omluvenek a jejich trvání"):
 * the portal header/tab, the admin participant detail, the studio liability list. Kept here so "available"
 * means the same thing everywhere: it delegates per credit to `isRedeemableNow` (live evaluation — a credit
 * whose `expires_at` has passed is NOT available even while a sweeper hasn't flipped its status yet).
 */
import { isRedeemableNow } from './expiry'

/** A credit as far as balance math cares. `expiresAt` null = never expires. */
export interface CreditForSummary {
  status: 'active' | 'redeemed' | 'expired' | 'cancelled'
  expiresAt: Date | null
}

export interface CreditSummary {
  /** Spendable right now: status 'active' AND not past `expiresAt` as of `now` (inclusive, per isRedeemableNow). */
  available: number
  /** Soonest non-null expiry among the AVAILABLE credits — "use it or lose it by …". Null = none expiring. */
  nextExpiresAt: Date | null
  /** Ever earned: everything except 'cancelled' (cancellations are corrections, not history). */
  issued: number
  /** Spent on a make-up: status 'redeemed'. */
  redeemed: number
}

/** Summarize a participant's credits as of `now`. */
export function summarizeCredits(credits: CreditForSummary[], now: Date): CreditSummary {
  let available = 0
  let nextExpiresAt: Date | null = null
  let issued = 0
  let redeemed = 0

  for (const c of credits) {
    if (c.status !== 'cancelled') issued += 1
    if (c.status === 'redeemed') redeemed += 1

    // Same redeemability semantics as redemption itself (no windows in the shipped subset → empty list).
    const usable = isRedeemableNow(
      { status: c.status, deletedAt: null, expiresAt: c.expiresAt, validWindowIds: [] },
      now,
    )
    if (!usable) continue

    available += 1
    if (c.expiresAt !== null && (nextExpiresAt === null || c.expiresAt.getTime() < nextExpiresAt.getTime())) {
      nextExpiresAt = c.expiresAt
    }
  }

  return { available, nextExpiresAt, issued, redeemed }
}
