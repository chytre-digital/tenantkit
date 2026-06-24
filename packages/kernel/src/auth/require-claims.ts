/**
 * BACK-COMPAT SHIM — `requireClaims` became `resolveClaims(req, runtime)` in the ports refactor (docs/14 §7).
 *
 * The old `requireClaims()` (React `cache()`, direct Supabase) is gone: the kernel no longer imports Supabase or
 * React, and identity now flows through `runtime.identity` / `runtime.authz`. This module re-exports the new
 * `resolveClaims` and the `AuthContext` family so existing deep imports (`auth/require-claims`) keep resolving.
 * Prefer importing from `auth/resolve-claims` (or the package barrel) in new code.
 */
export {
  resolveClaims,
  type AuthContext,
  type ProfileClaims,
  type Membership,
  type Guardianship,
  type GuardianRelation,
} from './resolve-claims'
