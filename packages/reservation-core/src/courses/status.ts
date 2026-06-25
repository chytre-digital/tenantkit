/**
 * Realizes docs/06-courses-and-terminar.md §2 (kind & session invariants) and §3 (status state machine) — PURE.
 *
 * The course is the spine; its lifecycle and the kind→session invariants are the rules every create/edit path
 * (and the DB checks) enforce. Kept as pure functions so the editor, the activate/complete/cancel actions, and
 * the create RPC all agree without re-deriving the rules.
 */

export type CourseStatus = 'draft' | 'active' | 'completed' | 'cancelled'
export type CourseKind = 'one_time' | 'multi_session'
export type CourseAction = 'activate' | 'complete' | 'cancel'

/** The state machine (doc 06 §3). Terminal states (`completed`/`cancelled`) have no outgoing transitions. */
const TRANSITIONS: Record<CourseStatus, Partial<Record<CourseAction, CourseStatus>>> = {
  draft: { activate: 'active', cancel: 'cancelled' },
  active: { complete: 'completed', cancel: 'cancelled' },
  completed: {},
  cancelled: {},
}

export function canTransitionCourse(from: CourseStatus, action: CourseAction): boolean {
  return TRANSITIONS[from][action] !== undefined
}

/** The resulting status, or throw if the transition is illegal (call `canTransitionCourse` first). */
export function nextCourseStatus(from: CourseStatus, action: CourseAction): CourseStatus {
  const to = TRANSITIONS[from][action]
  if (to === undefined) throw new Error(`[course] illegal transition: ${from} --${action}-->`)
  return to
}

/** A `completed`/`cancelled` course is read-only — mutations return `422 COURSE_LOCKED` (doc 06 §3). */
export function isCourseLocked(status: CourseStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

// ── kind ↔ session-count invariant (doc 06 §2) ──────────────────────────────────────────────────────────────

/** The allowed session count for a kind: one_time ⇒ exactly 1; multi_session ⇒ ≥ 2 (doc 06 §2). */
export function expectedSessionCount(kind: CourseKind): { min: number; max: number | null } {
  return kind === 'one_time' ? { min: 1, max: 1 } : { min: 2, max: null }
}

export function isValidSessionCount(kind: CourseKind, count: number): boolean {
  return kind === 'one_time' ? count === 1 : count >= 2
}

/**
 * `capacity` may be LOWERED only to ≥ the peak occupancy of any session, and is always ≥ 1; raising is always
 * allowed (doc 06 §3). Returns false ⇒ the caller raises `422 CAPACITY_BELOW_OCCUPANCY`.
 */
export function canSetCapacity(newCapacity: number, peakOccupancy: number): boolean {
  return newCapacity >= 1 && newCapacity >= peakOccupancy
}

// ── activation gate (doc 06 §2 invariants, checked at draft → active) ────────────────────────────────────────

/** A session as the invariant checks see it: its start and duration (for overlap). */
export interface SessionInterval {
  startsAt: Date
  durationMin: number
}

/** True if any two sessions' `[start, start+duration)` intervals intersect (doc 06 §2.2). */
export function hasOverlap(sessions: SessionInterval[]): boolean {
  const sorted = [...sessions].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    const prevEnd = prev.startsAt.getTime() + prev.durationMin * 60_000
    if (cur.startsAt.getTime() < prevEnd) return true
  }
  return false
}

export type ActivationProblem = 'wrong_session_count' | 'sessions_overlap' | 'session_in_past'

export interface ActivationCheck {
  kind: CourseKind
  sessions: SessionInterval[]
  /** When provided, every session must be future-dated (doc 06 §2.3). Omit to skip that clause. */
  now?: Date
}

/**
 * Can a `draft` course be activated (doc 06 §3, §2)? Validates the §2 invariants: correct session count,
 * non-overlapping sessions, and (if `now` is given) all sessions future-dated. Returns the failing reasons.
 */
export function validateForActivation(
  check: ActivationCheck,
): { ok: true } | { ok: false; problems: ActivationProblem[] } {
  const problems: ActivationProblem[] = []
  if (!isValidSessionCount(check.kind, check.sessions.length)) problems.push('wrong_session_count')
  if (hasOverlap(check.sessions)) problems.push('sessions_overlap')
  if (check.now !== undefined) {
    const cutoff = check.now.getTime()
    if (check.sessions.some((s) => s.startsAt.getTime() <= cutoff)) problems.push('session_in_past')
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true }
}
