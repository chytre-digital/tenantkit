/**
 * Realizes docs/08-attendance-and-omluvenky.md §5 — per-course expiration ("Platnost omluvenky"), the heart of
 * the feature. The brief's *"každému kurzu jde nastavit expirace omluvenkového tokenu"* maps exactly to a
 * course's `excuse_policy.expiry`. THE CREDIT IS THE TOKEN; this file turns the tagged-union policy into the
 * two physical columns (`credits.expires_at` and/or `credits.valid_window_ids`), and evaluates redeemability
 * LIVE at redemption time (doc 08 §5 — there is no background job whose run correctness depends on).
 *
 * Pure: no I/O. These functions are the ones doc 08 §13 demands pass before any UI exists.
 */

/** The expiry tagged union from doc 08 §5. A course picks exactly ONE mode. */
export type ExpiryPolicy =
  | { mode: 'none' }
  | { mode: 'ttl'; ttlDays: number }
  | { mode: 'course_end' }
  | { mode: 'windows'; windowIds: string[]; forwardWindows: number }

/** A named validity window (public.validity_windows, doc 03 §4) — a date range. */
export interface ValidityWindow {
  id: string
  startsOn: string // 'YYYY-MM-DD' (date-only)
  endsOn: string // 'YYYY-MM-DD'
}

/** Minimal course shape this module needs (its sessions, for `course_end`). */
export interface CourseForExpiry {
  id: string
  /** Ascending or unordered; `computeExpiry` finds the latest itself. */
  sessions: Array<{ startsAt: Date }>
}

/** The physical result `computeExpiry` writes onto the credit row (doc 08 §5 table). */
export interface ComputedExpiry {
  /** `ttl` / `course_end` collapse to a single timestamp; `none` / `windows` leave it null. */
  expiresAt: Date | null
  /** `windows` mode: the ordered window ids the credit is redeemable within; else empty. */
  validWindowIds: string[]
}

/** A credit as far as redeemability evaluation cares (doc 08 §5 "Expiry evaluation"). */
export interface CreditForRedeemCheck {
  status: 'active' | 'redeemed' | 'expired' | 'cancelled'
  deletedAt: Date | null
  expiresAt: Date | null
  validWindowIds: string[]
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Turn a course's `excuse_policy.expiry` into the credit's physical expiry columns (doc 08 §5).
 *
 * | mode        | produces                                            |
 * |-------------|-----------------------------------------------------|
 * | none        | expiresAt = null, validWindowIds = []               |
 * | ttl         | expiresAt = issuedAt + ttlDays                       |
 * | course_end  | expiresAt = last session's starts_at (null if none) |
 * | windows     | validWindowIds = [base, …+forwardWindows]           |
 *
 * @param policy  the chosen expiry mode
 * @param course  the SOURCE course (for `course_end`)
 * @param now     issue time (`issuedAt`)
 * @param windows the tenant's validity windows, used only by `windows` mode
 */
export function computeExpiry(
  policy: ExpiryPolicy,
  course: CourseForExpiry,
  now: Date,
  windows: ValidityWindow[] = [],
): ComputedExpiry {
  switch (policy.mode) {
    case 'none':
      // Evergreen memberships — credits never expire.
      return { expiresAt: null, validWindowIds: [] }

    case 'ttl':
      // "Use your makeup within N days." expires_at = issuedAt + ttlDays.
      return { expiresAt: new Date(now.getTime() + policy.ttlDays * MS_PER_DAY), validWindowIds: [] }

    case 'course_end': {
      // Seasonal blocks — valid until the source course's LAST session.
      // 0 sessions → null (nothing to anchor to → behaves as "never"); 1 or N → the latest starts_at.
      const last = latestSessionStart(course.sessions)
      return { expiresAt: last, validWindowIds: [] }
    }

    case 'windows': {
      // Term/quarter systems (legacy model): base window PLUS the next `forwardWindows`.
      const ids = forwardWindowIds(windows, policy.windowIds, policy.forwardWindows)
      return { expiresAt: null, validWindowIds: ids }
    }
  }
}

/** Latest `starts_at` among sessions, or null when there are none (the `course_end` 0-session case). */
function latestSessionStart(sessions: Array<{ startsAt: Date }>): Date | null {
  let latest: Date | null = null
  for (const s of sessions) {
    if (latest === null || s.startsAt.getTime() > latest.getTime()) latest = s.startsAt
  }
  return latest
}

/**
 * The `windows` forward math (doc 08 §5): order the tenant's windows by `starts_on`, find the base window's
 * index, and take that window plus the next `forwardWindows`. Example: base = "Jaro 2026", forwardWindows = 2
 * → [Jaro, Léto, Podzim] 2026. Unknown base ids are skipped; a base past the end yields just itself.
 */
function forwardWindowIds(
  windows: ValidityWindow[],
  baseWindowIds: string[],
  forwardWindows: number,
): string[] {
  const ordered = [...windows].sort((a, b) => a.startsOn.localeCompare(b.startsOn))
  const out = new Set<string>()
  for (const baseId of baseWindowIds) {
    const idx = ordered.findIndex((w) => w.id === baseId)
    if (idx === -1) continue // base not in this tenant's set — skip defensively
    for (let i = idx; i <= idx + forwardWindows && i < ordered.length; i++) {
      out.add(ordered[i]!.id)
    }
  }
  return [...out]
}

/**
 * Is the credit redeemable AS OF `today` (doc 08 §5 "Expiry evaluation")? Live evaluation — correctness never
 * depends on the nightly "flip to expired" job having run. All three clauses must hold:
 *   • status === 'active' AND deleted_at is null, AND
 *   • (expires_at is null OR today ≤ expires_at), AND
 *   • (valid_window_ids empty OR some window covers today: starts_on ≤ today ≤ ends_on).
 *
 * @param windows the tenant's validity windows, needed to resolve `valid_window_ids` to date ranges.
 */
export function isRedeemableNow(
  credit: CreditForRedeemCheck,
  today: Date,
  windows: ValidityWindow[] = [],
): boolean {
  // 1) state gate
  if (credit.status !== 'active') return false
  if (credit.deletedAt !== null) return false

  // 2) simple TTL / course_end timestamp gate (null = not constrained by a timestamp)
  if (credit.expiresAt !== null && today.getTime() > credit.expiresAt.getTime()) return false

  // 3) window gate (empty = not constrained by windows)
  if (credit.validWindowIds.length > 0) {
    const byId = new Map(windows.map((w) => [w.id, w]))
    const covered = credit.validWindowIds.some((id) => {
      const w = byId.get(id)
      return w !== undefined && coversDate(w, today)
    })
    if (!covered) return false
  }

  return true
}

/** Date-only containment: starts_on ≤ today ≤ ends_on, comparing on the calendar day (ignores time-of-day). */
function coversDate(window: ValidityWindow, today: Date): boolean {
  const d = toDateOnly(today)
  return window.startsOn <= d && d <= window.endsOn
}

/** Render a Date as a 'YYYY-MM-DD' string for lexical date-only comparison against window bounds. */
function toDateOnly(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
