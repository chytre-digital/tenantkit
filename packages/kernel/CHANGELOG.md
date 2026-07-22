# @deverjak/tenantkit-kernel

## 0.7.2

### Patch Changes

- Add optional direct-upload + object-stat capabilities to `StorageProvider` (Výkazník spec §7 / P2).

  - **Kernel:** two new OPTIONAL methods on `StorageProvider` — `createSignedUpload?(SignedUploadRequest)` (mint a
    short-lived pre-signed target so a client PUTs bytes straight to storage, bypassing the app server's memory)
    and `stat?({ bucket, key })` (object metadata, or `null` if absent). New exported types `SignedUploadRequest`,
    `SignedUploadTarget`, `StorageObjectStat`. Purely additive — existing adapters/consumers are unaffected.
  - **Supabase adapter:** implements both via `createSignedUploadUrl(key, { upsert })` and
    `storage.from(bucket).info(key)`; `stat` maps a missing object to `null` rather than throwing. The client is
    now injectable for unit tests. Deliberately vendor-neutral primitives only — photo/EXIF/thumbnail/AV/reward
    rules stay in the app.

## 0.7.1

### Patch Changes

- Add `diffRoleSeed(getRoles(), rows)` — a pure, read-only drift check between the app's declared roles
  (`defineRoles`) and the rows actually seeded in `core.roles`, returning a ready-to-log report of missing/extra
  roles and rank/flag mismatches (safe to run at startup or in CI; never mutates the DB). Exports the
  `RoleRow` / `RoleSeedDiff` / `RoleSeedMismatch` types and shares the owner-derivation with `rolesSeedSql` so the
  seed and the check agree by construction. Purely additive — existing APIs unchanged.

  Docs (`04-roles-and-permissions.md`): roles are now documented as **app-defined data**, not a framework enum —
  `defineRoles()` / `setPermissionGrants()` / the `core.roles` table, the `is_owner` / `is_admin` capability flags
  and the `core.is_owner()` / `core.is_admin()` predicates, the `defineRoles ⇄ core.roles` seed/verify bridge, and
  a clarification that rank does not imply automatic permission-grant inheritance.

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
