# @deverjak/tenantkit-kernel

## 0.5.0

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
