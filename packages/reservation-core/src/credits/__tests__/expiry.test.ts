/**
 * Realizes docs/08-attendance-and-omluvenky.md §13 — the pure-domain test list that MUST pass before any UI.
 * These functions are pure precisely so they're trivially testable (the legacy omluvenka bugs were all in
 * side-effecting handlers). Covers:
 *   • computeExpiry for each mode (incl. `windows` forward math; `course_end` with 0/1/N sessions)
 *   • isRedeemableNow truth table (active/expired/cancelled × ttl/window/none × inside/outside)
 *   • decideIssue (disabled, cap reached, happy path, tag snapshot)
 *   • redemption match (age in/out, tag overlap/none, same/cross course)
 *   • FIFO credit selection by expiry
 */
import { describe, it, expect } from 'vitest'
import {
  computeExpiry,
  isRedeemableNow,
  type CourseForExpiry,
  type ValidityWindow,
  type CreditForRedeemCheck,
} from '../expiry'
import { decideIssue, type Course, type Excuse } from '../issue'
import {
  matchesRedemption,
  selectCreditFIFO,
  ageInMonths,
  type CreditForRedemption,
  type TargetCourse,
  type ParticipantForRedemption,
} from '../redeem'

// --- fixtures -------------------------------------------------------------------------------------------------

const NOW = new Date('2026-03-01T10:00:00.000Z')

/** The tenant's validity windows, deliberately out of order to prove computeExpiry sorts by starts_on. */
const WINDOWS: ValidityWindow[] = [
  { id: 'w-podzim', startsOn: '2026-09-01', endsOn: '2026-11-30' }, // Podzim 2026
  { id: 'w-jaro', startsOn: '2026-03-01', endsOn: '2026-05-31' }, // Jaro 2026
  { id: 'w-leto', startsOn: '2026-06-01', endsOn: '2026-08-31' }, // Léto 2026
  { id: 'w-zima', startsOn: '2026-12-01', endsOn: '2027-02-28' }, // Zima 2026/27
]

function courseWithSessions(starts: string[]): CourseForExpiry {
  return { id: 'c1', sessions: starts.map((s) => ({ startsAt: new Date(s) })) }
}

// --- computeExpiry --------------------------------------------------------------------------------------------

describe('computeExpiry (doc 08 §5)', () => {
  it("mode 'none' → never expires (null expiry, no windows)", () => {
    const r = computeExpiry({ mode: 'none' }, courseWithSessions([]), NOW)
    expect(r.expiresAt).toBeNull()
    expect(r.validWindowIds).toEqual([])
  })

  it("mode 'ttl' → issuedAt + ttlDays", () => {
    const r = computeExpiry({ mode: 'ttl', ttlDays: 30 }, courseWithSessions([]), NOW)
    expect(r.expiresAt?.toISOString()).toBe('2026-03-31T10:00:00.000Z')
    expect(r.validWindowIds).toEqual([])
  })

  describe("mode 'course_end' (0/1/N sessions)", () => {
    it('0 sessions → null (nothing to anchor to)', () => {
      const r = computeExpiry({ mode: 'course_end' }, courseWithSessions([]), NOW)
      expect(r.expiresAt).toBeNull()
    })

    it('1 session → that session start', () => {
      const r = computeExpiry({ mode: 'course_end' }, courseWithSessions(['2026-05-10T16:00:00.000Z']), NOW)
      expect(r.expiresAt?.toISOString()).toBe('2026-05-10T16:00:00.000Z')
    })

    it('N sessions (unordered) → the LATEST starts_at', () => {
      const course = courseWithSessions([
        '2026-05-10T16:00:00.000Z',
        '2026-06-21T16:00:00.000Z', // latest
        '2026-04-01T16:00:00.000Z',
      ])
      const r = computeExpiry({ mode: 'course_end' }, course, NOW)
      expect(r.expiresAt?.toISOString()).toBe('2026-06-21T16:00:00.000Z')
    })
  })

  describe("mode 'windows' (forward math, doc 08 §5)", () => {
    it('forwardWindows: 2 from Jaro → [Jaro, Léto, Podzim] (sorted by starts_on)', () => {
      const r = computeExpiry(
        { mode: 'windows', windowIds: ['w-jaro'], forwardWindows: 2 },
        courseWithSessions([]),
        NOW,
        WINDOWS,
      )
      expect(r.expiresAt).toBeNull()
      expect(r.validWindowIds).toEqual(['w-jaro', 'w-leto', 'w-podzim'])
    })

    it('forwardWindows: 0 → just the base window', () => {
      const r = computeExpiry(
        { mode: 'windows', windowIds: ['w-jaro'], forwardWindows: 0 },
        courseWithSessions([]),
        NOW,
        WINDOWS,
      )
      expect(r.validWindowIds).toEqual(['w-jaro'])
    })

    it('base near the end → clamps to available windows (no overflow)', () => {
      const r = computeExpiry(
        { mode: 'windows', windowIds: ['w-podzim'], forwardWindows: 5 },
        courseWithSessions([]),
        NOW,
        WINDOWS,
      )
      expect(r.validWindowIds).toEqual(['w-podzim', 'w-zima'])
    })

    it('unknown base id → skipped (empty result)', () => {
      const r = computeExpiry(
        { mode: 'windows', windowIds: ['w-nope'], forwardWindows: 2 },
        courseWithSessions([]),
        NOW,
        WINDOWS,
      )
      expect(r.validWindowIds).toEqual([])
    })
  })
})

// --- isRedeemableNow truth table ------------------------------------------------------------------------------

describe('isRedeemableNow truth table (doc 08 §5)', () => {
  const base: CreditForRedeemCheck = {
    status: 'active',
    deletedAt: null,
    expiresAt: null,
    validWindowIds: [],
  }
  const today = new Date('2026-04-15T12:00:00.000Z') // inside Jaro 2026

  // status axis
  it("status 'active' + no constraints → redeemable", () => {
    expect(isRedeemableNow(base, today)).toBe(true)
  })
  it("status 'redeemed' → not redeemable", () => {
    expect(isRedeemableNow({ ...base, status: 'redeemed' }, today)).toBe(false)
  })
  it("status 'expired' → not redeemable", () => {
    expect(isRedeemableNow({ ...base, status: 'expired' }, today)).toBe(false)
  })
  it("status 'cancelled' → not redeemable", () => {
    expect(isRedeemableNow({ ...base, status: 'cancelled' }, today)).toBe(false)
  })
  it('soft-deleted (deletedAt set) → not redeemable', () => {
    expect(isRedeemableNow({ ...base, deletedAt: new Date('2026-04-01') }, today)).toBe(false)
  })

  // ttl axis
  it('ttl, today before expiry → redeemable', () => {
    expect(isRedeemableNow({ ...base, expiresAt: new Date('2026-05-01') }, today)).toBe(true)
  })
  it('ttl, today after expiry → not redeemable', () => {
    expect(isRedeemableNow({ ...base, expiresAt: new Date('2026-04-01') }, today)).toBe(false)
  })

  // window axis
  it('window, today inside a covering window → redeemable', () => {
    expect(isRedeemableNow({ ...base, validWindowIds: ['w-jaro'] }, today, WINDOWS)).toBe(true)
  })
  it('window, today outside all windows → not redeemable', () => {
    // today is in Jaro; only Léto/Podzim are allowed → not covered.
    expect(isRedeemableNow({ ...base, validWindowIds: ['w-leto', 'w-podzim'] }, today, WINDOWS)).toBe(false)
  })
  it('window, today inside one of several → redeemable (any-covers)', () => {
    expect(isRedeemableNow({ ...base, validWindowIds: ['w-jaro', 'w-podzim'] }, today, WINDOWS)).toBe(true)
  })
})

// --- decideIssue ----------------------------------------------------------------------------------------------

describe('decideIssue (doc 08 §4)', () => {
  function course(overrides: Partial<Course['excusePolicy']> = {}, tags: string[] = ['plavani', 'baby']): Course {
    return {
      id: 'c1',
      sessions: [{ startsAt: new Date('2026-06-01T16:00:00.000Z') }],
      tags,
      excusePolicy: {
        creditsEnabled: true,
        expiry: { mode: 'ttl', ttlDays: 30 },
        selfExcuseDeadlineHours: 24,
        redeemMatch: { ageMatchRequired: true, sameTagsRequired: true, crossCourse: false },
        ...overrides,
      },
    }
  }
  const excuse = (count = 0): Excuse => ({
    sessionId: 's1',
    participantId: 'p1',
    enrollmentId: 'e1',
    enrollmentCreditCount: count,
  })

  it('creditsEnabled = false → no issue', () => {
    const d = decideIssue(course({ creditsEnabled: false }), excuse(), NOW)
    expect(d).toEqual({ issue: false, reason: 'credits_disabled' })
  })

  it('cap reached (count >= maxCreditsPerEnrollment) → no issue', () => {
    const d = decideIssue(course({ maxCreditsPerEnrollment: 2 }), excuse(2), NOW)
    expect(d).toEqual({ issue: false, reason: 'cap_reached' })
  })

  it('under cap → issues', () => {
    const d = decideIssue(course({ maxCreditsPerEnrollment: 2 }), excuse(1), NOW)
    expect(d.issue).toBe(true)
  })

  it('happy path → issues with computed expiry and snapshotted tags', () => {
    const d = decideIssue(course(), excuse(), NOW)
    expect(d.issue).toBe(true)
    if (d.issue) {
      expect(d.expiry.expiresAt?.toISOString()).toBe('2026-03-31T10:00:00.000Z') // ttl 30d from NOW
      expect(d.tags).toEqual(['plavani', 'baby'])
    }
  })

  it('tag snapshot is a COPY (mutating the course tags later does not change the decision)', () => {
    const c = course({}, ['plavani'])
    const d = decideIssue(c, excuse(), NOW)
    c.tags.push('mutated-after-issue')
    if (d.issue) expect(d.tags).toEqual(['plavani'])
  })
})

// --- redemption match -----------------------------------------------------------------------------------------

describe('matchesRedemption (doc 08 §6)', () => {
  const participant: ParticipantForRedemption = { id: 'p1', dateOfBirth: new Date('2025-01-01') } // ~14 months at NOW
  function credit(overrides: Partial<CreditForRedemption> = {}): CreditForRedemption {
    return {
      id: 'cr1',
      participantId: 'p1',
      tags: ['plavani', 'baby'],
      redeemMatch: { ageMatchRequired: true, sameTagsRequired: true, crossCourse: true },
      sourceCourseId: 'src-course',
      expiresAt: null,
      ...overrides,
    }
  }
  const target = (o: Partial<TargetCourse> = {}): TargetCourse => ({
    id: 'tgt-course',
    ageMinMonths: 6,
    ageMaxMonths: 36,
    tags: ['plavani'],
    ...o,
  })

  it('age inside band + tag overlap + crossCourse → ok', () => {
    expect(matchesRedemption(credit(), target(), participant)).toEqual({ ok: true })
  })

  it('age OUTSIDE band (too old) → age_mismatch', () => {
    expect(matchesRedemption(credit(), target({ ageMinMonths: 60, ageMaxMonths: 84 }), participant)).toEqual({
      ok: false,
      reason: 'age_mismatch',
    })
  })

  it('no tag overlap → tag_mismatch', () => {
    expect(matchesRedemption(credit(), target({ tags: ['tanec'] }), participant)).toEqual({
      ok: false,
      reason: 'tag_mismatch',
    })
  })

  it('crossCourse=false + different target course → cross_course_forbidden', () => {
    const c = credit({ redeemMatch: { ageMatchRequired: false, sameTagsRequired: false, crossCourse: false } })
    expect(matchesRedemption(c, target({ id: 'tgt-course' }), participant)).toEqual({
      ok: false,
      reason: 'cross_course_forbidden',
    })
  })

  it('crossCourse=false + SAME course → ok', () => {
    const c = credit({
      sourceCourseId: 'same',
      redeemMatch: { ageMatchRequired: false, sameTagsRequired: false, crossCourse: false },
    })
    expect(matchesRedemption(c, target({ id: 'same' }), participant)).toEqual({ ok: true })
  })

  it('relaxed rules (all off) → ok regardless of age/tags', () => {
    const c = credit({
      redeemMatch: { ageMatchRequired: false, sameTagsRequired: false, crossCourse: true },
      tags: [],
    })
    expect(matchesRedemption(c, target({ tags: ['nothing-in-common'], ageMinMonths: 200 }), participant)).toEqual({
      ok: true,
    })
  })

  it('credit belongs to a different participant → wrong_participant', () => {
    expect(matchesRedemption(credit({ participantId: 'other' }), target(), participant)).toEqual({
      ok: false,
      reason: 'wrong_participant',
    })
  })
})

describe('ageInMonths', () => {
  it('computes whole months, not-yet-reached day rolls back a month', () => {
    expect(ageInMonths(new Date('2025-01-15'), new Date('2026-01-10'))).toBe(11)
    expect(ageInMonths(new Date('2025-01-15'), new Date('2026-01-20'))).toBe(12)
  })
  it('null dob → null', () => {
    expect(ageInMonths(null)).toBeNull()
  })
})

// --- FIFO selection -------------------------------------------------------------------------------------------

describe('selectCreditFIFO (doc 08 §11 — spend soonest-expiring first)', () => {
  it('picks the soonest-expiring credit', () => {
    const picked = selectCreditFIFO([
      { id: 'late', expiresAt: new Date('2026-12-01') },
      { id: 'soon', expiresAt: new Date('2026-04-01') },
      { id: 'mid', expiresAt: new Date('2026-08-01') },
    ])
    expect(picked?.id).toBe('soon')
  })

  it('never-expiring (null) credits sort LAST', () => {
    const picked = selectCreditFIFO([
      { id: 'never', expiresAt: null },
      { id: 'dated', expiresAt: new Date('2026-09-01') },
    ])
    expect(picked?.id).toBe('dated')
  })

  it('empty list → null', () => {
    expect(selectCreditFIFO([])).toBeNull()
  })
})
