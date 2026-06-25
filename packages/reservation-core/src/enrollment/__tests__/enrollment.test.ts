/**
 * Realizes docs/07-registration-and-enrollment.md §2/§4/§6/§8/§9 — the pure enrollment rules, proven before any
 * UI/RPC: age recommendation, guardian/participant dedupe keys, the application state machine, and the
 * enrollable/waitlist predicates.
 */
import { describe, it, expect } from 'vitest'
import { recommendCourse, isWithinAgeBand, isOutsideAgeBand, type RecommendableCourse } from '../recommend'
import {
  normalizeGuardianEmail,
  participantMatchKey,
  applicationDedupeKey,
  violatesActiveEnrollmentUniqueness,
} from '../dedupe'
import {
  canTransitionApplication,
  nextApplicationStatus,
  canAutoReverseEnrollment,
  isPubliclyEnrollable,
  isOpenForOnlineRegistration,
  isWaitlisted,
} from '../application'

describe('age recommendation (doc 07 §2, doc 06 §7)', () => {
  const courses: RecommendableCourse[] = [
    { id: 'zabicky', ageMinMonths: 12, ageMaxMonths: 23 },
    { id: 'babies', ageMinMonths: 0, ageMaxMonths: 11 },
    { id: 'open', ageMinMonths: null, ageMaxMonths: null }, // open-ended
  ]

  it('picks the first course whose band contains the age', () => {
    expect(recommendCourse(14, courses)).toBe('zabicky')
    expect(recommendCourse(6, courses)).toBe('babies')
    expect(recommendCourse(50, courses)).toBe('open') // only the open band matches
  })

  it('returns null for an unknown (null) age', () => {
    expect(recommendCourse(null, courses)).toBeNull()
  })

  it('isWithinAgeBand treats null bounds as open-ended; isOutsideAgeBand never flags a null age', () => {
    expect(isWithinAgeBand(14, { ageMinMonths: 12, ageMaxMonths: 23 })).toBe(true)
    expect(isWithinAgeBand(24, { ageMinMonths: 12, ageMaxMonths: 23 })).toBe(false)
    expect(isWithinAgeBand(200, { ageMinMonths: 12, ageMaxMonths: null })).toBe(true) // open upper
    expect(isOutsideAgeBand(30, { ageMinMonths: 12, ageMaxMonths: 23 })).toBe(true)
    expect(isOutsideAgeBand(null, { ageMinMonths: 12, ageMaxMonths: 23 })).toBe(false)
  })
})

describe('dedupe keys (doc 07 §6, §9)', () => {
  it('normalizes the guardian email (trim + lowercase)', () => {
    expect(normalizeGuardianEmail('  Eva@Studio.CZ ')).toBe('eva@studio.cz')
  })

  it('keys a child by name + DOB', () => {
    expect(participantMatchKey({ fullName: '  Tomáš  ', dateOfBirth: '2024-05-01' })).toBe('tomáš|2024-05-01')
    expect(participantMatchKey({ fullName: 'Tomáš', dateOfBirth: null })).toBe('tomáš|')
  })

  it('builds a stable application dedupe key (normalized email, lowercased name)', () => {
    const key = applicationDedupeKey({
      tenantId: 't1',
      guardianEmail: 'Eva@Studio.cz',
      childName: 'Tomáš',
      childDob: '2024-05-01',
      courseId: 'c1',
    })
    expect(key).toBe('t1|eva@studio.cz|tomáš|2024-05-01|c1')
  })

  it('detects an existing ACTIVE enrollment (and ignores cancelled / other courses)', () => {
    const existing = [
      { courseId: 'c1', participantId: 'p1', status: 'cancelled' },
      { courseId: 'c1', participantId: 'p1', status: 'active' },
    ]
    expect(violatesActiveEnrollmentUniqueness(existing, { courseId: 'c1', participantId: 'p1' })).toBe(true)
    expect(violatesActiveEnrollmentUniqueness(existing, { courseId: 'c2', participantId: 'p1' })).toBe(false)
    expect(
      violatesActiveEnrollmentUniqueness([{ courseId: 'c1', participantId: 'p1', status: 'cancelled' }], {
        courseId: 'c1',
        participantId: 'p1',
      }),
    ).toBe(false)
  })
})

describe('application state machine (doc 07 §4, §9)', () => {
  it('approves/rejects only from pending; resets only from a decided state', () => {
    expect(canTransitionApplication('pending', 'approve')).toBe(true)
    expect(canTransitionApplication('pending', 'reject')).toBe(true)
    expect(canTransitionApplication('pending', 'reset')).toBe(false)
    expect(canTransitionApplication('approved', 'approve')).toBe(false)
    expect(canTransitionApplication('approved', 'reset')).toBe(true)
    expect(canTransitionApplication('rejected', 'reset')).toBe(true)
  })

  it('nextApplicationStatus resolves or throws', () => {
    expect(nextApplicationStatus('pending', 'approve')).toBe('approved')
    expect(nextApplicationStatus('approved', 'reset')).toBe('pending')
    expect(() => nextApplicationStatus('approved', 'approve')).toThrow(/illegal transition/)
  })

  it('auto-reverses an enrollment only when nothing has accrued', () => {
    expect(canAutoReverseEnrollment({ hasAttendance: false, hasPayment: false })).toBe(true)
    expect(canAutoReverseEnrollment({ hasAttendance: true, hasPayment: false })).toBe(false)
    expect(canAutoReverseEnrollment({ hasAttendance: false, hasPayment: true })).toBe(false)
  })
})

describe('enrollable / waitlist predicates (doc 07 §8)', () => {
  it('isPubliclyEnrollable requires active + public + open registration', () => {
    expect(isPubliclyEnrollable({ status: 'active', showOnPublic: true, registrationMode: 'open' })).toBe(true)
    expect(isPubliclyEnrollable({ status: 'draft', showOnPublic: true, registrationMode: 'open' })).toBe(false)
    expect(isPubliclyEnrollable({ status: 'active', showOnPublic: false, registrationMode: 'open' })).toBe(false)
    expect(isPubliclyEnrollable({ status: 'active', showOnPublic: true, registrationMode: 'staff_only' })).toBe(false)
  })

  it('staff_only is not open for online registration', () => {
    expect(isOpenForOnlineRegistration({ registrationMode: 'open' })).toBe(true)
    expect(isOpenForOnlineRegistration({ registrationMode: 'staff_only' })).toBe(false)
  })

  it('isWaitlisted = pending + full', () => {
    expect(isWaitlisted({ status: 'pending' }, true)).toBe(true)
    expect(isWaitlisted({ status: 'pending' }, false)).toBe(false)
    expect(isWaitlisted({ status: 'approved' }, true)).toBe(false)
  })
})
