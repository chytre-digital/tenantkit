# @deverjak/tenantkit-adapter-supabase

## 0.6.0

### Minor Changes

- Add opt-in hybrid cookie / Bearer request authentication.

  `createSupabaseRuntime({ requestAuth: { mode: 'cookie' | 'bearer' | 'cookie-or-bearer' } })` lets the same
  Next.js Route Handlers authenticate a web session cookie **or** a Supabase access token in
  `Authorization: Bearer …` (mobile/Expo). A single internal resolver picks the credential once per request, so
  both the guard (`ctx.claims`) and the RLS DB scope (`ctx.db.user()`) always derive from the **same** credential.

  - New `bearerUserClient(accessToken)` (anon key + `Authorization` header; never the service-role key) and the
    `resolveRequestCredential` / `SupabaseRequestAuthMode` / `SupabaseRequestAuthOptions` exports.
  - `IdentityProvider.getCurrentUser` server-verifies a Bearer token and returns `null` (→ `401`) for a
    missing / expired / corrupt token; a malformed `Authorization` header never silently falls back to the cookie.
  - A Bearer request emits **no `Set-Cookie`** — `SupabaseSessionStore.refresh()` no-ops for the mobile transport.
  - The Supabase conformance harness is now real (was a `TODO` stub): the full port suite runs for **both** the
    cookie and Bearer transports against real Postgres RLS, plus an integration security matrix.

  **Default is unchanged:** `mode` defaults to `'cookie'`, so existing apps behave byte-for-byte as before.

## 0.3.0

### Minor Changes

- feat: URL-slug tenant resolution (`withSlugRoute`) — the Makerkit-style stateless selector (docs/17 §2).

  - **kernel**: new `withSlugRoute(opts, handler)` wrapper — resolves the tenant from a `[slug]` route param
    (Next 15/16 Promise params handled) via the new `AuthzStore.getTenantBySlug(slug)` port method, for ALL
    audiences (public/staff/family). `ctx.tenant: { id, slug, name, tier }` is always set; entitlements are
    built from `tenant.tier` (no extra `getTenantTier` read); the family audience is scoped to the resolved
    tenant; guard order is `401 → 404 → 403`. Options: `audience`, `slugParam` (default `'slug'`) + the shared
    policy set (`minRole`/`can`/`plugin`/`entitlements`/`rateLimit`/`body`/`query`).
  - **kernel**: new `resolveTenantWorkspace(runtime, slug, { minRole?, req? })` — the page-layer companion for
    gated layouts; returns `{ ok, workspace | reason }`, never redirects.
  - **kernel**: `withRoute` and the active-tenant cookie helpers (`readActiveTenantCookie`,
    `setActiveTenantCookie`, `resolveActiveTenant`) carry `@deprecated` LEGACY markers — they remain fully
    supported for cookie/host (subdomain / custom-domain) tenancy; new slug-in-URL apps should use
    `withSlugRoute`.
  - **BREAKING for custom `AuthzStore` implementations**: the port gained `getTenantBySlug(slug)` — add the
    method (a `select id, slug, name, tier from tenants where slug = $1` read; return `null` for an unknown
    slug, THROW on transport/config errors). Note: `withSlugRoute` requires an adapter whose `getTenantBySlug`
    works without a user session (the Supabase adapter uses the service-role client — the service key is
    required even for public-only slug routes).
  - **adapter-supabase**: `SupabaseAuthzStore.getTenantBySlug` (service-role read of `core.tenants`).
  - **testing**: `MemoryAuthzStore.getTenantBySlug`, slug-resolution conformance cases, and a full
    `withSlugRoute` + `resolveTenantWorkspace` behavior suite.

### Patch Changes

- Updated dependencies
  - @deverjak/tenantkit-kernel@0.5.0
