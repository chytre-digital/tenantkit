/**
 * Realizes docs/07-registration-and-enrollment.md §4 (approval workflow), §8 (waitlist / staff_only), §9
 * (edge cases) — PURE. The application state machine, the enrollable predicates, and the pure guards the
 * approval RPC applies (the atomic capacity re-check + the auto-reverse rule).
 */

/** doc 03 §5 `application_status`. `Vrátit` resets a decided application back to `pending` (no separate enum). */
export type ApplicationStatus = 'pending' | 'approved' | 'rejected'
export type ApplicationAction = 'approve' | 'reject' | 'reset'

const TRANSITIONS: Record<ApplicationStatus, Partial<Record<ApplicationAction, ApplicationStatus>>> = {
  pending: { approve: 'approved', reject: 'rejected' },
  approved: { reset: 'pending' },
  rejected: { reset: 'pending' },
}

export function canTransitionApplication(from: ApplicationStatus, action: ApplicationAction): boolean {
  return TRANSITIONS[from][action] !== undefined
}

export function nextApplicationStatus(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus {
  const to = TRANSITIONS[from][action]
  if (to === undefined) throw new Error(`[application] illegal transition: ${from} --${action}-->`)
  return to
}

/**
 * `Vrátit` after approval may auto-reverse the just-created enrollment ONLY if nothing has accrued against it
 * (doc 07 §9); otherwise staff must cancel the enrollment explicitly. The facts come from queries; the decision
 * is pure.
 */
export function canAutoReverseEnrollment(facts: { hasAttendance: boolean; hasPayment: boolean }): boolean {
  return !facts.hasAttendance && !facts.hasPayment
}

// ── enrollable predicates (doc 07 §8, doc 06 §1) ─────────────────────────────────────────────────────────────

/** A course as the enrollment gates see it (doc 06 §1 columns). */
export interface EnrollableCourse {
  status: string // course_status
  showOnPublic: boolean
  registrationMode: 'open' | 'staff_only'
}

/**
 * Visible on the anon catalogue AND accepting the public QR form: active + public + open registration
 * (doc 07 §8; mirrors the RLS `public_catalogue` predicate plus the funnel's `staff_only` exclusion).
 */
export function isPubliclyEnrollable(course: EnrollableCourse): boolean {
  return course.status === 'active' && course.showOnPublic && course.registrationMode === 'open'
}

/** A `staff_only` course has no public form — a deep link is rejected "not open for online registration". */
export function isOpenForOnlineRegistration(course: { registrationMode: 'open' | 'staff_only' }): boolean {
  return course.registrationMode !== 'staff_only'
}

/**
 * Waitlisted (doc 07 §8): a pending application whose desired session is full. Promotion is a manual staff
 * action (v1) — there is no auto-promotion. `sessionFull` comes from the capacity math (courses/capacity.ts).
 */
export function isWaitlisted(application: { status: ApplicationStatus }, sessionFull: boolean): boolean {
  return application.status === 'pending' && sessionFull
}
