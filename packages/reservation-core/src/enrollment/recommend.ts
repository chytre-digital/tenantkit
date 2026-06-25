/**
 * Realizes docs/07-registration-and-enrollment.md §2 (age recommendation) + docs/06 §7 (age band) — PURE.
 *
 * The public QR funnel computes the child's age in months from DOB and PRE-SELECTS the course whose age band
 * contains it (advisory only — the parent may override to any course, doc 07 §2). The same age-band predicate
 * also backs the soft "mimo věkové rozmezí" warning at approval (doc 07 §9). Age itself is always computed from
 * `date_of_birth`, never stored (doc 06 §7, doc 03 §4).
 *
 * Null-bound policy (the one genuine ambiguity in the spec): a null `ageMin`/`ageMax` is treated as OPEN-ENDED
 * (−∞ / +∞), consistent with the makeup matcher's `ageWithinBand` (credits/redeem.ts). A null DOB ⇒ null age ⇒
 * no recommendation and no warning (we can't tell).
 */
import { ageInMonths } from '../credits/redeem'

// Re-export the canonical age helper as the funnel's `ageMonths` (doc 07 §2 names it `ageMonths`).
export { ageInMonths }

/** A nullable age band in MONTHS (doc 03 §4 `age_min_months` / `age_max_months`, both nullable). */
export interface AgeBand {
  ageMinMonths: number | null
  ageMaxMonths: number | null
}

/** Is `ageMonths` inside `[min, max]` (inclusive; a null bound is open on that side)? Null age ⇒ false. */
export function isWithinAgeBand(ageMonths: number | null, band: AgeBand): boolean {
  if (ageMonths === null) return false
  if (band.ageMinMonths !== null && ageMonths < band.ageMinMonths) return false
  if (band.ageMaxMonths !== null && ageMonths > band.ageMaxMonths) return false
  return true
}

/**
 * A SOFT "outside the age band" check for the approval warning (doc 07 §9 — warn, never block). Null age ⇒
 * false (unknown age can't be flagged as outside).
 */
export function isOutsideAgeBand(ageMonths: number | null, band: AgeBand): boolean {
  if (ageMonths === null) return false
  return !isWithinAgeBand(ageMonths, band)
}

/** A course as the recommender sees it — just its id + age band. */
export interface RecommendableCourse extends AgeBand {
  id: string
}

/**
 * Recommend the FIRST course (in the given catalogue order) whose age band contains `ageMonths` (doc 07 §2).
 * Returns the course id, or null when the age is unknown or no course matches. Advisory — never forces a choice.
 * The caller passes an already-filtered list (active + publicly enrollable); this fn doesn't filter.
 */
export function recommendCourse(ageMonths: number | null, courses: RecommendableCourse[]): string | null {
  if (ageMonths === null) return null
  const match = courses.find((c) => isWithinAgeBand(ageMonths, c))
  return match ? match.id : null
}
