/**
 * The make-up ("náhrada") capacity rule — PURE. Realizes the terminar v1 shipped semantics (docs/08 addendum):
 * capacity lives on the COURSE (no per-session override), and an enrollee who EXCUSED themselves from a given
 * session frees their seat for that session only. So, per target session:
 *
 *   free = capacity − activeEnrollments + excusedForSession − bookedMakeups
 *
 * This is the availability half the portal grid renders; the atomic half (the same formula re-checked under
 * `SELECT … FOR UPDATE` on the course row) lives in the `book_makeup` SECURITY DEFINER RPC — dual enforcement
 * by design (doc 08 §13).
 */

/** Per-session occupancy inputs for one make-up target session. */
export interface MakeupCapacityInputs {
  /** The target COURSE's capacity (terminar has no per-session capacity override). */
  capacity: number
  /** Active enrollments in the target course (they own a seat in every session). */
  activeEnrollments: number
  /**
   * Enrollees excused from THIS session — each frees their seat for this one session. Count only participants
   * who actually hold an active enrollment in the course (a guest's excused mark frees nothing).
   */
  excusedForSession: number
  /** Make-ups already booked (status='booked') into THIS session. */
  bookedMakeups: number
}

/**
 * Free make-up seats for one session. May be negative (over-booked course after a capacity reduction) —
 * callers clamp for display; "bookable" is `> 0`.
 */
export function freeMakeupCapacity(i: MakeupCapacityInputs): number {
  return i.capacity - i.activeEnrollments + i.excusedForSession - i.bookedMakeups
}
