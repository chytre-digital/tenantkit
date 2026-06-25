/**
 * @reservation-core/domain — the reservation domain on the @tenantkit/* kernel (ADR-0010, layer 2).
 *
 * Three pure, vendor-free sub-domains, each namespaced:
 *   - `courses`     capacity/occupancy math, the course status state machine + kind/session invariants, and the
 *                   recurrence generator (docs/06).
 *   - `enrollment`  age-based course recommendation, guardian/participant dedupe, the application state machine,
 *                   and the enrollable/waitlist predicates (docs/07).
 *   - `credits`     the omluvenka excuse → makeup-credit → redeem engine (docs/08).
 * The kernel knows nothing about any of these; this layer knows nothing about Supabase.
 */
export * as credits from './credits/index'
export * as courses from './courses/index'
export * as enrollment from './enrollment/index'
