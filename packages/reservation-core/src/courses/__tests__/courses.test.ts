/**
 * Realizes docs/06-courses-and-terminar.md §2–§4 — the course capacity math + status state machine + invariants,
 * proven pure (the DoD: these pass before any UI). Recurrence has its own file.
 */
import { describe, it, expect } from 'vitest'
import {
  effectiveCapacity,
  occupancy,
  freeSeats,
  isFull,
  isSessionFull,
  occupancyState,
} from '../capacity'
import {
  canTransitionCourse,
  nextCourseStatus,
  isCourseLocked,
  expectedSessionCount,
  isValidSessionCount,
  canSetCapacity,
  hasOverlap,
  validateForActivation,
  type SessionInterval,
} from '../status'

describe('capacity / occupancy (doc 06 §4)', () => {
  it('effectiveCapacity inherits the course default unless the session overrides', () => {
    expect(effectiveCapacity({ capacityOverride: null }, { capacity: 12 })).toBe(12)
    expect(effectiveCapacity({ capacityOverride: 6 }, { capacity: 12 })).toBe(6)
  })

  it('occupancy sums block members + makeup guests; isFull/freeSeats follow', () => {
    expect(occupancy({ activeEnrollments: 8, bookedMakeups: 2 })).toBe(10)
    expect(freeSeats(10, 12)).toBe(2)
    expect(isFull(12, 12)).toBe(true)
    expect(isFull(11, 12)).toBe(false)
  })

  it('isSessionFull composes effectiveCapacity + occupancy', () => {
    const session = { capacityOverride: 10 }
    const course = { capacity: 12 }
    expect(isSessionFull(session, course, { activeEnrollments: 9, bookedMakeups: 1 })).toBe(true) // 10 >= 10
    expect(isSessionFull(session, course, { activeEnrollments: 8, bookedMakeups: 1 })).toBe(false) // 9 < 10
  })

  it('occupancyState buckets by free seats (free>2 / 1..2 / <=0)', () => {
    expect(occupancyState(5, 12)).toBe('free') // free 7
    expect(occupancyState(10, 12)).toBe('near_full') // free 2
    expect(occupancyState(11, 12)).toBe('near_full') // free 1
    expect(occupancyState(12, 12)).toBe('full') // free 0
    expect(occupancyState(13, 12)).toBe('full') // over
  })
})

describe('status state machine (doc 06 §3)', () => {
  it('allows the legal transitions and rejects the rest', () => {
    expect(canTransitionCourse('draft', 'activate')).toBe(true)
    expect(canTransitionCourse('draft', 'cancel')).toBe(true)
    expect(canTransitionCourse('active', 'complete')).toBe(true)
    expect(canTransitionCourse('active', 'cancel')).toBe(true)
    expect(canTransitionCourse('draft', 'complete')).toBe(false)
    expect(canTransitionCourse('completed', 'activate')).toBe(false)
  })

  it('nextCourseStatus returns the target or throws on an illegal transition', () => {
    expect(nextCourseStatus('draft', 'activate')).toBe('active')
    expect(nextCourseStatus('active', 'complete')).toBe('completed')
    expect(() => nextCourseStatus('completed', 'activate')).toThrow(/illegal transition/)
  })

  it('locks terminal states', () => {
    expect(isCourseLocked('completed')).toBe(true)
    expect(isCourseLocked('cancelled')).toBe(true)
    expect(isCourseLocked('active')).toBe(false)
    expect(isCourseLocked('draft')).toBe(false)
  })
})

describe('kind / session invariants (doc 06 §2)', () => {
  it('enforces the session-count rule per kind', () => {
    expect(expectedSessionCount('one_time')).toEqual({ min: 1, max: 1 })
    expect(expectedSessionCount('multi_session')).toEqual({ min: 2, max: null })
    expect(isValidSessionCount('one_time', 1)).toBe(true)
    expect(isValidSessionCount('one_time', 2)).toBe(false)
    expect(isValidSessionCount('multi_session', 1)).toBe(false)
    expect(isValidSessionCount('multi_session', 7)).toBe(true)
  })

  it('capacity may be lowered only to >= peak occupancy, and never below 1', () => {
    expect(canSetCapacity(10, 8)).toBe(true)
    expect(canSetCapacity(8, 8)).toBe(true)
    expect(canSetCapacity(7, 8)).toBe(false) // below peak occupancy
    expect(canSetCapacity(0, 0)).toBe(false) // below 1
  })

  it('detects overlapping sessions', () => {
    const at = (iso: string, dur: number): SessionInterval => ({ startsAt: new Date(iso), durationMin: dur })
    expect(hasOverlap([at('2026-09-07T16:00:00Z', 60), at('2026-09-07T16:30:00Z', 30)])).toBe(true)
    expect(hasOverlap([at('2026-09-07T16:00:00Z', 60), at('2026-09-07T17:00:00Z', 30)])).toBe(false)
    expect(hasOverlap([at('2026-09-07T16:00:00Z', 60)])).toBe(false)
  })
})

describe('validateForActivation (doc 06 §2, §3)', () => {
  const future = (iso: string, dur = 45): SessionInterval => ({ startsAt: new Date(iso), durationMin: dur })
  const NOW = new Date('2026-08-01T00:00:00Z')

  it('passes a well-formed multi_session course', () => {
    const r = validateForActivation({
      kind: 'multi_session',
      sessions: [future('2026-09-07T16:00:00Z'), future('2026-09-14T16:00:00Z')],
      now: NOW,
    })
    expect(r).toEqual({ ok: true })
  })

  it('reports the wrong session count', () => {
    const r = validateForActivation({ kind: 'one_time', sessions: [future('2026-09-07T16:00:00Z'), future('2026-09-14T16:00:00Z')] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems).toContain('wrong_session_count')
  })

  it('reports overlap and past-dated sessions', () => {
    const r = validateForActivation({
      kind: 'multi_session',
      sessions: [future('2026-07-01T16:00:00Z', 120), future('2026-07-01T17:00:00Z', 30)], // overlap + in the past
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problems).toContain('sessions_overlap')
      expect(r.problems).toContain('session_in_past')
    }
  })
})
