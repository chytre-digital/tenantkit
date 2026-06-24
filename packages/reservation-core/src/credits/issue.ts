/**
 * Realizes docs/08-attendance-and-omluvenky.md §4 — credit issuance rules (the PURE decision).
 *
 * Issuance is decoupled from the excuse record: the use-case emits `attendance.excused` on `core.outbox`
 * (doc 09 §5.1) and the issuance handler consumes it, so email/SMS/money plugins can react without coupling.
 * The whole decision is this one pure function — the legacy system's omluvenka bugs all lived in side-effecting
 * handlers; ours can't, because the rule does no I/O. If `issue`, the handler writes
 * `public.credits(status='active', tags, …)` with the computed expiry and links the excuse.
 */
import { computeExpiry, type CourseForExpiry, type ExpiryPolicy, type ValidityWindow } from './expiry'

/** The redeem-match rules a course imposes on credits sourced from it (doc 08 §6, §12). */
export interface RedeemMatch {
  /** participant's age (from date_of_birth) ∈ target course [age_min_months, age_max_months]. */
  ageMatchRequired: boolean
  /** target course tags ∩ credit.tags ≠ ∅. */
  sameTagsRequired: boolean
  /** false → target must be the SAME course as the source; true → any suitable course. */
  crossCourse: boolean
}

/** A course's full `excuse_policy` (doc 03 §4 `courses.excuse_policy` jsonb; surface in doc 08 §12). */
export interface ExcusePolicy {
  creditsEnabled: boolean
  expiry: ExpiryPolicy
  /** "Termín pro vlastní omluvení" — hours before start a guardian may self-excuse (doc 08 §3). */
  selfExcuseDeadlineHours: number
  /** "Strop omluvenek na účastníka" — optional per-enrollment cap. */
  maxCreditsPerEnrollment?: number
  redeemMatch: RedeemMatch
}

/** The source course as issuance sees it: its policy, its tags (snapshotted onto the credit), its sessions. */
export interface Course extends CourseForExpiry {
  tags: string[]
  excusePolicy: ExcusePolicy
}

/** The excuse being processed; `enrollmentCreditCount` is how many credits this enrollment already has. */
export interface Excuse {
  sessionId: string
  participantId: string
  enrollmentId: string | null
  /** Count of credits already issued for this enrollment — drives the cap check. */
  enrollmentCreditCount: number
}

/** Why issuance was declined (for the audit trail / staff explanation). */
export type IssueDeclineReason = 'credits_disabled' | 'cap_reached'

/**
 * The decision. When `issue`, `tags` is the snapshot to copy onto the credit and `expiry` is the computed
 * physical expiry (doc 08 §4: tags are snapshotted from the SOURCE course at issue time so later course edits
 * don't change an issued credit's redeem-matching).
 */
export type IssueDecision =
  | { issue: false; reason?: IssueDeclineReason }
  | {
      issue: true
      tags: string[]
      expiry: ReturnType<typeof computeExpiry>
    }

/**
 * Decide whether marking this excuse should mint an omluvenka, and with what tags/expiry (doc 08 §4).
 *
 *   if (!creditsEnabled)                                  → { issue: false, reason: 'credits_disabled' }
 *   if (cap set && already >= cap)                        → { issue: false, reason: 'cap_reached' }
 *   else                                                  → { issue: true, tags, expiry: computeExpiry(...) }
 *
 * @param windows the tenant's validity windows (only consulted by `expiry.mode === 'windows'`).
 */
export function decideIssue(
  course: Course,
  excuse: Excuse,
  now: Date,
  windows: ValidityWindow[] = [],
): IssueDecision {
  const p = course.excusePolicy

  // Toggle: "Generovat omluvenky za omluvené absence" (doc 08 §12). Off → excuse is recorded but mints nothing.
  if (!p.creditsEnabled) return { issue: false, reason: 'credits_disabled' }

  // Cap: "Strop omluvenek na účastníka" (doc 08 §4). Already at/over the cap → decline.
  if (p.maxCreditsPerEnrollment != null && excuse.enrollmentCreditCount >= p.maxCreditsPerEnrollment) {
    return { issue: false, reason: 'cap_reached' }
  }

  // Happy path — snapshot the source course's tags and stamp the computed expiry.
  return {
    issue: true,
    tags: [...course.tags],
    expiry: computeExpiry(p.expiry, course, now, windows),
  }
}
