/**
 * Realizes docs/07-registration-and-enrollment.md §6 (guardian/participant dedupe) + §9 (duplicate detection) —
 * PURE key derivation. The I/O orchestration (find-or-create + account provisioning) is NOT here; these are the
 * normalization + match-key rules it relies on, kept pure so client and server derive identical keys.
 *
 * Guardian identity is keyed on `lower(guardian_email)` — one guardian account, many child participants. A child
 * is matched within a guardian by `full_name` + `date_of_birth`. A duplicate PENDING application is detected on
 * `(tenant, guardian_email, child_name, child_dob, course)` so a double submit is merged, not re-queued.
 */

/** Canonical guardian email: trimmed + lower-cased (doc 07 §6 "find … by lower(email)"). */
export function normalizeGuardianEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** The guardian dedupe key — one account per normalized email (doc 07 §6). */
export function guardianMatchKey(email: string): string {
  return normalizeGuardianEmail(email)
}

/** A child's identity within a guardian (doc 07 §6: matched by name + DOB). `dateOfBirth` is 'YYYY-MM-DD'|null. */
export interface ChildIdentity {
  fullName: string
  dateOfBirth: string | null
}

/** Child match key within a guardian: normalized name + DOB (doc 07 §6). Empty DOB participates as ''. */
export function participantMatchKey(child: ChildIdentity): string {
  return `${child.fullName.trim().toLowerCase()}|${child.dateOfBirth ?? ''}`
}

/** The tuple a duplicate pending application is detected on (doc 07 §9). `courseId` null ⇒ unassigned. */
export interface ApplicationIdentity {
  tenantId: string
  guardianEmail: string
  childName: string
  childDob: string | null
  courseId: string | null
}

/** Stable dedupe key for a pending application — a second matching submit is merged/flagged, not re-queued. */
export function applicationDedupeKey(application: ApplicationIdentity): string {
  return [
    application.tenantId,
    normalizeGuardianEmail(application.guardianEmail),
    application.childName.trim().toLowerCase(),
    application.childDob ?? '',
    application.courseId ?? '',
  ].join('|')
}

/** An existing enrollment as the uniqueness check sees it. */
export interface EnrollmentRef {
  courseId: string
  participantId: string
  status: string // 'active' | 'cancelled' | 'completed'
}

/**
 * The pure side of the partial-unique index `enrollments(course_id, participant_id) where status='active'`
 * (doc 03 §5, doc 07 §4.1): is there already an ACTIVE enrollment for this (course, participant)? A second one
 * is a `409 CONFLICT` / no-op.
 */
export function violatesActiveEnrollmentUniqueness(
  existing: EnrollmentRef[],
  candidate: { courseId: string; participantId: string },
): boolean {
  return existing.some(
    (e) => e.status === 'active' && e.courseId === candidate.courseId && e.participantId === candidate.participantId,
  )
}
