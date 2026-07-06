/**
 * freeMakeupCapacity — the terminar v1 make-up availability formula:
 *   free = capacity − activeEnrollments + excusedForSession − bookedMakeups
 * Covers the excused-frees-seat case, full/over-booked (negative) results, and the guest caveat
 * (excusedForSession is defined as ENROLLED excusees only — a guest's mark must not be counted by callers).
 */
import { describe, it, expect } from 'vitest'
import { freeMakeupCapacity } from '../capacity'

describe('freeMakeupCapacity', () => {
  it('base case: spare course capacity → free seats', () => {
    expect(freeMakeupCapacity({ capacity: 10, activeEnrollments: 8, excusedForSession: 0, bookedMakeups: 0 })).toBe(2)
  })

  it('full course, one enrollee excused → exactly their seat is free for this session', () => {
    expect(freeMakeupCapacity({ capacity: 10, activeEnrollments: 10, excusedForSession: 1, bookedMakeups: 0 })).toBe(1)
  })

  it('the freed seat is consumed by a booked make-up', () => {
    expect(freeMakeupCapacity({ capacity: 10, activeEnrollments: 10, excusedForSession: 1, bookedMakeups: 1 })).toBe(0)
  })

  it('full course, nobody excused → nothing free', () => {
    expect(freeMakeupCapacity({ capacity: 10, activeEnrollments: 10, excusedForSession: 0, bookedMakeups: 0 })).toBe(0)
  })

  it('spare capacity and an excused enrollee ADD UP (both kinds of free seat)', () => {
    expect(freeMakeupCapacity({ capacity: 12, activeEnrollments: 10, excusedForSession: 2, bookedMakeups: 1 })).toBe(3)
  })

  it('may go negative (capacity reduced under existing enrollment) — callers clamp for display', () => {
    expect(freeMakeupCapacity({ capacity: 8, activeEnrollments: 10, excusedForSession: 0, bookedMakeups: 0 })).toBe(-2)
  })

  it('zero-capacity course is never bookable', () => {
    expect(
      freeMakeupCapacity({ capacity: 0, activeEnrollments: 0, excusedForSession: 0, bookedMakeups: 0 }),
    ).toBe(0)
  })
})
