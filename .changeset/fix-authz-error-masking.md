---
"@deverjak/tenantkit-adapter-supabase": patch
---

Fix `SupabaseAuthzStore` silently swallowing PostgREST errors as empty results.

`getMembershipsWithTenants()` and `getMemberships()` only destructured `data` from the first membership query, so
a real query failure (`{ data: null, error }` — e.g. an unexposed `core` schema or a missing grant) was
indistinguishable from "user genuinely has no memberships" and surfaced as `[]`. Callers then fail-opened an
authenticated existing owner into onboarding to create a new organization instead of surfacing an infrastructure
error. `ensureProfile`, `getParticipantAccounts`, `getPluginActivation`, and `getTenantTier` had the same gap and
are fixed the same way: every PostgREST `error` is now propagated, and `data: []` / `data: null` (no row) is
trusted as a legitimate empty result only when `error` is `null`.

The Supabase client is also now constructor-injectable on `SupabaseAuthzStore` (mirrors `SupabaseStorage`), so
this error-propagation contract has direct unit test coverage instead of relying only on the in-memory
conformance store, which cannot represent a transport/config error.
