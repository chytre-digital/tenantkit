/**
 * Realizes docs/08-attendance-and-omluvenky.md §6 (redemption match rules) and §11 (FIFO selection) — PURE.
 *
 * When a guardian books a makeup, the credit must MATCH the target session's course. The rules are driven by the
 * SOURCE course's `redeemMatch` (snapshotted onto the credit at issue): age band, tag overlap, same-vs-cross
 * course. The capacity/`SELECT … FOR UPDATE` half is NOT here — that is the atomic concern of the
 * `redeem_credit_into_session` SECURITY DEFINER RPC (doc 08 §6 step 3, db/migrations/0003_omluvenky.sql).
 * This file is the matching predicate the RPC and the portal availability grid both apply.
 */
import type { RedeemMatch } from './issue'

/** The credit as redemption sees it: its snapshotted tags, match rules, and (for FIFO) its effective expiry. */
export interface CreditForRedemption {
  id: string
  participantId: string
  tags: string[]
  /** The match rules snapshotted from the source course at issue time (doc 08 §4). */
  redeemMatch: RedeemMatch
  sourceCourseId: string | null
  /** Used by `selectCreditFIFO` — the soonest-expiring redeemable credit is spent first (doc 08 §11). */
  expiresAt: Date | null
}

/** The makeup-target course (doc 08 §6 step 2 reads age band + tags off the TARGET). */
export interface TargetCourse {
  id: string
  ageMinMonths: number | null
  ageMaxMonths: number | null
  tags: string[]
}

/** The participant being booked — age is computed from `dateOfBirth`, never stored (doc 03 §4). */
export interface ParticipantForRedemption {
  id: string
  dateOfBirth: Date | null
}

/** Outcome of a match check — a stable reason on failure, for the `422` the RPC raises / the grid's tooltip. */
export type RedemptionMatch =
  | { ok: true }
  | { ok: false; reason: 'wrong_participant' | 'age_mismatch' | 'tag_mismatch' | 'cross_course_forbidden' }

/**
 * Does `credit` match `targetCourse` for `participant` (doc 08 §6 step 2)? Applies, in order:
 *   0. the credit belongs to the participant being booked (defensive; RLS/`can_act_for_participant` is the real gate).
 *   1. crossCourse === false → target.id must equal credit.sourceCourseId.
 *   2. ageMatchRequired → ageInMonths(participant) ∈ [target.ageMinMonths, target.ageMaxMonths].
 *   3. sameTagsRequired → target.tags ∩ credit.tags ≠ ∅.
 *
 * Capacity is intentionally NOT checked here (see file header).
 */
export function matchesRedemption(
  credit: CreditForRedemption,
  targetCourse: TargetCourse,
  participant: ParticipantForRedemption,
): RedemptionMatch {
  const m = credit.redeemMatch

  // 0) sanity — the credit and the participant must be the same person.
  if (credit.participantId !== participant.id) return { ok: false, reason: 'wrong_participant' }

  // 1) "Pouze stejný kurz" — crossCourse === false locks redemption to the source course.
  if (!m.crossCourse && credit.sourceCourseId !== null && targetCourse.id !== credit.sourceCourseId) {
    return { ok: false, reason: 'cross_course_forbidden' }
  }

  // 2) "Odpovídající věk" — participant's age in months must fall in the TARGET course's band.
  if (m.ageMatchRequired && !ageWithinBand(participant.dateOfBirth, targetCourse)) {
    return { ok: false, reason: 'age_mismatch' }
  }

  // 3) "Stejné zaměření (tagy)" — non-empty intersection of target tags and the credit's snapshotted tags.
  if (m.sameTagsRequired && !hasTagOverlap(credit.tags, targetCourse.tags)) {
    return { ok: false, reason: 'tag_mismatch' }
  }

  return { ok: true }
}

/**
 * Does the credit's validity COVER the target session's calendar day (doc 08 §6 step 2b / §14)? A credit
 * "platí do 5. 8." books lessons THROUGH 5. 8. and never a lesson on 6. 8. — the expiry bounds the TARGET
 * lesson's date, not just the booking moment (`isRedeemableNow` handles that). Compared at DAY level in the
 * studio timezone (inclusive), so a ttl credit stamped 5.8. 18:30 still books the 5.8. 21:00 lesson —
 * matching the displayed date. `expiresAt === null` covers everything. SQL mirror: the coverage clause in
 * `book_makeup`'s FIFO pick.
 */
export function creditCoversSession(
  credit: { expiresAt: Date | null },
  sessionStart: Date,
  timeZone = 'Europe/Prague',
): boolean {
  if (credit.expiresAt === null) return true
  return dayInZone(sessionStart, timeZone) <= dayInZone(credit.expiresAt, timeZone)
}

/** A Date's calendar day as 'YYYY-MM-DD' in an IANA zone (en-CA locale formats exactly that shape). */
function dayInZone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(d)
}

/**
 * FIFO selection (doc 08 §11): when a participant has multiple active credits, spend the SOONEST-EXPIRING
 * redeemable one first. Credits with no expiry (`none` mode) sort LAST (they can always be spent later).
 * The caller has already filtered to credits that are redeemable now, match the target, and COVER the target
 * session's day (`creditCoversSession`); this only orders them and returns the head. Returns null on an
 * empty list.
 */
export function selectCreditFIFO<T extends { expiresAt: Date | null }>(credits: T[]): T | null {
  if (credits.length === 0) return null
  const sorted = [...credits].sort((a, b) => {
    // null expiry → +Infinity so never-expiring credits are spent last.
    const ax = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY
    const bx = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY
    return ax - bx
  })
  return sorted[0]!
}

/** Age in whole months from `dob` to `asOf` (defaults to now). Null dob → null (can't satisfy a required band). */
export function ageInMonths(dob: Date | null, asOf: Date = new Date()): number | null {
  if (dob === null) return null
  let months = (asOf.getUTCFullYear() - dob.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - dob.getUTCMonth())
  if (asOf.getUTCDate() < dob.getUTCDate()) months -= 1 // not yet reached the day-of-month → one fewer month
  return Math.max(0, months)
}

/** participant age ∈ [min, max] (inclusive; either bound null = open on that side). Null age fails a required check. */
function ageWithinBand(dob: Date | null, course: TargetCourse): boolean {
  const age = ageInMonths(dob)
  if (age === null) return false
  if (course.ageMinMonths !== null && age < course.ageMinMonths) return false
  if (course.ageMaxMonths !== null && age > course.ageMaxMonths) return false
  return true
}

/** Non-empty intersection between two tag lists. */
function hasTagOverlap(a: string[], b: string[]): boolean {
  const set = new Set(a)
  return b.some((t) => set.has(t))
}
