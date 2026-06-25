/**
 * Realizes docs/06-courses-and-terminar.md §4 — capacity & occupancy ("obsazenost"), PURE.
 *
 * Two inputs, one derived number. The actual COUNTS (active enrollments in the course, booked makeups into a
 * specific session) are I/O — the caller supplies them; this module is the arithmetic the QR slot chips, the
 * portal makeup grid, and the *Kurzy* list all share. The race-safe seat-take is the atomic capacity RPC
 * (doc 02 §14); this is the read-side math, never trusted at write time.
 */

/** A course's default seats per session (doc 06 §1: `capacity`, ≥ 1). */
export interface CapacityCourse {
  capacity: number
}

/** A session may override the course default (doc 06 §4: `capacity_override`, null inherits). */
export interface CapacitySession {
  capacityOverride: number | null
}

/** The seat counts for a session (doc 06 §4): block members + makeup guests. Both come from COUNT(*) queries. */
export interface OccupancyCounts {
  /** (a) active enrollments in the parent course — each holds a seat in EVERY session of the block. */
  activeEnrollments: number
  /** (b) makeups redeemed INTO this specific session by participants from other courses (doc 08). */
  bookedMakeups: number
}

/** `capacity_override ?? course.capacity` — the session's real seat count (doc 06 §4). */
export function effectiveCapacity(session: CapacitySession, course: CapacityCourse): number {
  return session.capacityOverride ?? course.capacity
}

/** occupancy = block members + makeup guests (doc 06 §4). */
export function occupancy(counts: OccupancyCounts): number {
  return counts.activeEnrollments + counts.bookedMakeups
}

/** free = capacity − occupied (may be negative if over-seated; callers clamp for display). */
export function freeSeats(occupied: number, capacity: number): number {
  return capacity - occupied
}

/** The primitive full test: occupied ≥ capacity (doc 06 §4). */
export function isFull(occupied: number, capacity: number): boolean {
  return occupied >= capacity
}

/** Convenience composing the above: is THIS session full, given its counts and the course default? */
export function isSessionFull(
  session: CapacitySession,
  course: CapacityCourse,
  counts: OccupancyCounts,
): boolean {
  return isFull(occupancy(counts), effectiveCapacity(session, course))
}

/** The occupancy badge buckets (doc 06 §4): Volno / Skoro plno / Obsazeno, by free-seat thresholds. */
export type OccupancyState = 'free' | 'near_full' | 'full'

/** free > 2 → 'free'; 1 ≤ free ≤ 2 → 'near_full'; free ≤ 0 → 'full' (doc 06 §4 table). */
export function occupancyState(occupied: number, capacity: number): OccupancyState {
  const free = freeSeats(occupied, capacity)
  if (free <= 0) return 'full'
  if (free <= 2) return 'near_full'
  return 'free'
}
