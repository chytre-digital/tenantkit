# 02 — `reservation-core` (the framework)

> The reusable foundation. Everything in this document is **product‑agnostic**: it knows about *tenants,
> members, roles, plans, plugins, routes, and email* — never about *courses, sessions, or omluvenky*.
> Termínář 2 (and later NaLekci, Restaurio) are thin domains on top.

## 1. Why it exists (read this first)

`main-panel` and `admin-console` were explored side‑by‑side. They independently re‑implemented the **same**
building blocks with the **same names**:

- the four Supabase client factories (`server` / `client` / `admin` / `proxy` `updateSession`),
- `withAuthRoute({ getXId, requireX, minRole, entitlements }, handler)`,
- `requireClaims()` → an `AuthContext` of memberships,
- an active‑tenant **cookie** + `switch-tenant` route,
- `roles.ts` (`AppRole`, `roleAtLeast`), 
- the HTTP stack (`jsonOk`/`jsonError`, `HttpError` + factories, Postgres‑error → HTTP mapping),
- the Zod validation stack (`parseJson` → `ParseResult` union),
- the entitlements engine (`TIER_ENTITLEMENTS`, `checkEntitlements`),
- the Resend transactional layer,
- the next‑intl wiring.

The only real difference was the **tenant noun**: `instructor`/`studio` vs `restaurant`. That single coupling
is what `reservation-core` generalizes. Promoting the rest to a package deletes thousands of lines of drift
(the two apps already disagree on details — e.g. duplicate `jsonOk`, an i18n config split). See
[ADR‑0002](adr/0002-extract-reservation-core.md).

## 2. "Multi‑tenant, multi‑modal, with roles" — defined

The brief asks for *"multitenant multimodal s rolema."* Concretely the core is **modal along four axes**, and
the same `withRoute` + RLS machinery serves all of them:

1. **Tenant modality** — the tenant noun is configurable. An app declares its taxonomy once:
   ```ts
   // apps/terminar/core.config.ts
   export const tenancy = defineTenancy({
     tenantTable: 'tenants',                 // the org table
     membershipTable: 'memberships',         // user ↔ tenant ↔ role
     tenantTerm: { one: 'studio', cs: 'studio' },
   })
   ```
   NaLekci would pass `instructors`/`instructor_memberships`; Restaurio `restaurants`/`restaurant_memberships`.
2. **Identity modality** — two kinds of authenticated subject coexist:
   - **Staff** — a user with `memberships` in a tenant (role‑scoped, admin console).
   - **Family** — a **Guardian/Participant** account with `participant_accounts` over participants (portal).
   `requireClaims()` returns both shapes; `withRoute` can require either (`audience: 'staff' | 'family'`).
3. **Auth modality** — password, OAuth, magic link, OTP, and login‑less **safe‑link** tokens — all first‑class.
4. **Surface modality** — admin console, public, portal, ops. A route declares which surface/audience it
   serves; defaults are safe (deny).

## 3. Package map — two layers

The framework ships as **two layers** in one public monorepo, published as granular npm packages
([ADR‑0010](adr/0010-two-layer-packaging-and-oss-repos.md)). **Layer 1 (`@tenantkit/*`)** is the *generic*
multi‑tenant SaaS backbone — useful to anyone, vendor‑neutral via ports ([ADR‑0009](adr/0009-portability-ports-and-adapters.md),
[14](14-portability-and-providers.md)). **Layer 2 (`@reservation-core/*`)** is the *reservation* domain on top.
The product (Termínář / NaLekci / Restaurio) stays private and consumes the published packages. Names are
provisional.

**Layer 1 — `@tenantkit/*` (generic backbone):**

| Package | Contains | Depends on |
|---|---|---|
| `@tenantkit/kernel` | the **ports** + `withRoute` runtime, `with-route`, `resolve-claims`, http, validation, rbac, entitlements, tenancy, plugins, i18n, the port‑delegating **email**, the **`fields`** module (configurable field schema, [15](15-configurable-fields-and-settings.md)), and the **db** RLS SQL (`is_member_of()`, `set_updated_at()`, the canonical policy macros) | Postgres + RLS only |
| `@tenantkit/next` | the **Next.js binding** (route adapter, `cookies()`/`updateSession` seam, `cache()`) | Next.js, kernel |
| `@tenantkit/adapter-supabase` | the **reference runtime** — `createSupabaseRuntime()` wiring Database/Identity/Session/Authz/Storage ([adapter README](https://github.com/chytre-digital/tenantkit-adapter-supabase)) | kernel, supabase‑js |
| `@tenantkit/adapter-postgres` · `@tenantkit/adapter-authjs` | driver DB + Auth.js identity adapters *(planned)* — same ports, no app change | kernel |
| `@tenantkit/email-resend` | `EmailProvider` over Resend | kernel |
| `@tenantkit/payments-stripe` | `PaymentProvider` over Stripe | kernel |
| `@tenantkit/testing` | **in‑memory** adapters + the **conformance suite** (the bar every adapter must pass) | vitest, kernel |

**Layer 2 — `@reservation-core/*` (the reservation domain):**

| Package | Contains | Depends on |
|---|---|---|
| `@reservation-core/domain` | courses / sessions / capacity + the **omluvenka** credit engine (excuse → credit → makeup), pure types & policy helpers | kernel |
| `plugins/*` | the first‑party plugins — `payments`, `sms`, `booking-calendar`, `ratings` (each a per‑tenant activation, gated by tier) | kernel, domain |

The rest of this doc walks each kernel subsystem with real signatures. Mockup source lives in
[`packages/kernel/`](../packages/kernel/) (kernel) and [`packages/reservation-core/`](../packages/) (domain);
the reference runtime is [`packages/adapter-supabase/`](https://github.com/chytre-digital/tenantkit-adapter-supabase).

> **Ports refactor** ([ADR‑0009](adr/0009-portability-ports-and-adapters.md), [14](14-portability-and-providers.md)):
> the kernel no longer imports Supabase. `withRoute` now takes a **`runtime: CoreRuntime`** (the bag of ports —
> `identity`, `db: Database`, `authz`, `email`, optional `payments`/`storage`, `clock`, `ids`), wired once per app
> and pre‑bound into a thin `route(opts, handler)`. The handler's **`RouteCtx` exposes `db: RequestDb`** — the
> three role‑scoped handles `db.user()` / `db.anon()` / `db.service()` — **not** `supabase`. Everything below is
> phrased against these ports; concrete vendors are adapter packages selected in `core.config.ts`.

## 4. `withRoute` / `withSlugRoute` — the one way to write an endpoint

The generalization of both apps' `withAuthRoute`. A single wrapper that resolves identity, tenant, role,
plugin‑gating, and validation, then hands a typed context to the handler. **Every** API route uses one of the
two wrappers — they share the pipeline (steps 5–10 live once in the internal `route-pipeline.ts`) and differ
only in **how the tenant is resolved**:

- **`withSlugRoute`** (§4a, recommended for new apps) — the tenant is **named in the URL** (`/projects/[slug]/…`,
  Makerkit‑style, [17 §2](17-makerkit-comparison.md)); no ambient state, no cookie.
- **`withRoute`** (below, **LEGACY**) — the ambient chain `tenantFrom` (param/host/cookie/fn) ending in the
  validated `active_tenant_id` cookie. Kept fully supported for cookie/host (subdomain / custom‑domain)
  tenancy — the Restaurio/NaLekci inheritance.

```ts
// @tenantkit/kernel
export function withRoute<TArgs extends unknown[]>(
  opts: RouteOptions<TArgs>,
  handler: (ctx: RouteCtx, ...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response>

export interface RouteOptions<TArgs extends unknown[]> {
  /** The wired bag of ports (db, identity, authz, email, …). REQUIRED; apps pre-bind it (ports refactor, §3). */
  runtime: CoreRuntime
  /** Who may call this. 'public' = no auth; 'staff' = tenant member; 'family' = guardian/participant. */
  audience?: 'public' | 'staff' | 'family'        // default 'staff'
  /** How to find the tenant for staff routes. */
  tenantFrom?: 'cookie' | 'param' | 'host' | ((...a: TArgs) => Promisable<string | null>)
  requireTenant?: boolean                          // default true for 'staff'
  /** Minimum role in the resolved tenant (staff audience). */
  minRole?: AppRole
  /** Fine-grained permission(s) required, e.g. 'courses:edit:any'. ANDed with minRole. */
  can?: Permission | Permission[]
  /** Gate behind a plugin: the tenant must have it enabled AND be entitled to it. */
  plugin?: PluginId
  /** Declarative plan gating independent of a plugin. */
  entitlements?: { features?: FeatureKey[]; minTier?: Tier }
  /** Per-identity rate limit, e.g. { key: 'magic-link', limit: 5, window: '10m' }. */
  rateLimit?: RateLimitSpec
  /** Validate the request body/query; the parsed value is passed to the handler. */
  body?: ZodSchema; query?: ZodSchema
}

export interface RouteCtx {
  db: RequestDb                           // the three role-scoped handles: db.user() / db.anon() / db.service()
  locale: Locale
  // staff:
  claims: AuthContext | null              // null for 'public'
  tenantId: string | null
  role: AppRole | null
  can: (perm: Permission) => boolean
  entitlements: EntitlementsService | null
  // family:
  participant: ParticipantContext | null  // when audience === 'family'
  // parsed inputs (typed via opts.body / opts.query):
  input: { body?: unknown; query?: unknown }
}
```

**Pipeline** (in order, each step a clean early‑return error):

1. `runtime.db.forRequest(req)` → the RLS‑scoped `RequestDb` into `ctx.db` (port, not a vendor client).
2. Resolve locale from the request (cookie/header) → `ctx.locale`.
3. If `audience !== 'public'`: `resolveClaims(req, runtime)` → `401 UNAUTHORIZED` if no session.
4. Staff: resolve `tenantId` via `tenantFrom`; assert membership → `403 NOT_A_MEMBER`; resolve `role`.
   Family: resolve `ParticipantContext` (the participants this account may act for).
5. `minRole`/`can`: `roleAtLeast(role, minRole)` and `can(perm)` → `403 FORBIDDEN`.
6. `plugin`: tenant has it enabled (`plugin_activations`) **and** entitled (tier) → else `422 PLUGIN_NOT_ENABLED`.
7. `entitlements`: `checkEntitlements(...)` → `403 UPGRADE_REQUIRED` / `FEATURE_NOT_AVAILABLE`.
8. `rateLimit`: per‑identity token bucket → `429 RATE_LIMITED`.
9. `body`/`query`: `parseJson`/`parseQuery` → `400 VALIDATION_ERROR`; typed result into `ctx.input`.
10. Run `handler`. Any throw → `jsonError(e)`.

> The usage examples below elide `runtime` for brevity: in practice each app wires the ports once and exports a
> **pre‑bound** `route = (opts, handler) => withRoute({ ...opts, runtime }, handler)` (see
> `apps/*/src/server/route.ts` and the [adapter README](https://github.com/chytre-digital/tenantkit-adapter-supabase)), so call sites
> pass only the per‑route options.

**Canonical usage** (a coach taking attendance, gated by nothing special):

```ts
// apps/terminar/app/api/sessions/[id]/attendance/route.ts
export const POST = withRoute(
  { audience: 'staff', minRole: 'coach', tenantFrom: 'cookie',
    can: 'attendance:record', body: RecordAttendanceSchema },
  async (ctx, _req: Request, { params }: { params: { id: string } }) => {
    const result = await recordAttendance(ctx, {        // application use-case
      sessionId: params.id, marks: ctx.input.body!.marks,
    })
    return jsonOk({ attendance: result })
  },
)
```

**Family usage** (a guardian redeeming an omluvenka — gated by the `omluvenky` feature being on):

```ts
// apps/terminar/app/api/portal/credits/[id]/redeem/route.ts
export const POST = withRoute(
  { audience: 'family', body: RedeemSchema },
  async (ctx, _req, { params }) => {
    const booking = await redeemCredit(ctx, { creditId: params.id, sessionId: ctx.input.body!.sessionId })
    return jsonOk({ booking })
  },
)
```

Preset bundles (like the legacy `instructorBillingRouteOptions`) are just objects:
`export const ownerOnly = { minRole: 'owner' } satisfies RouteOptions`.

## 4a. `withSlugRoute` — URL‑addressable tenancy (recommended)

The slug‑in‑path wrapper ([17 §2](17-makerkit-comparison.md) — the Makerkit‑style stateless selector). The
tenant is resolved from a `[slug]` route param through the `AuthzStore.getTenantBySlug(slug)` port — for
**every** audience, `public` included (a public enrollment form is still a *tenant's* form). The active‑tenant
cookie is never read or written; switching tenants is navigation.

```ts
// @tenantkit/kernel
export function withSlugRoute<TArgs extends unknown[]>(
  opts: SlugRouteOptions,
  handler: (ctx: SlugRouteCtx, ...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response>

export interface SlugRouteOptions extends CommonRouteOptions {   // minRole/can/plugin/entitlements/rateLimit/body/query
  audience?: 'public' | 'staff' | 'family'   // default 'staff'; tenant resolved from the slug for ALL audiences
  slugParam?: string                          // route-param key, default 'slug' (a `[slug]` segment)
}

export interface SlugRouteCtx extends RouteCtx {
  tenant: TenantSummary                       // { id, slug, name, tier } — ALWAYS resolved (unknown slug → 404)
  tenantId: string                            // = tenant.id (compat with tenantId-keyed code)
}
```

**Deltas vs. the legacy pipeline** (steps 6–10 identical):

| Step | `withSlugRoute` |
|---|---|
| 3. identity | staff/family: `resolveClaims` → `401` **before** the slug lookup (an anonymous probe learns nothing about slugs). |
| 4. tenant | `await params` (Next 15/16 pass a Promise) → `slugParam` → `getTenantBySlug` → **`404 NOT_FOUND`** when unknown. Missing param key = programming error → 500. |
| 4b. staff | `assertMember` → `403 NOT_A_MEMBER`; **entitlements built from `tenant.tier`** — no `getTenantTier` round‑trip. |
| 4b. family | `ParticipantContext` **scoped to the resolved tenant** → `403 NOT_A_PARTICIPANT` when no link *here*. |
| 4b. public | no identity; `ctx.tenant` still set — so `plugin` gating works on public slug routes too. |

Guard order: **`401 → 404 → 403`**. A signed‑in non‑member gets `403` on a real slug, `404` on a bogus one.

**Canonical usage** (Termínář's `/api/projects/[slug]/courses`):

```ts
export const POST = route(                    // route = pre-bound withSlugRoute (apps/*/src/server/route.ts)
  { audience: 'staff', minRole: 'coach' },
  async (ctx, req: Request) => {
    const courseId = await saveCourse(ctx.tenant.id, ctx.claims!.userId, null, await parse(req, ctx.locale))
    return jsonOk({ courseId }, { status: 201 })
  },
)
```

**The page‑layer companion — `resolveTenantWorkspace`** (Makerkit's `loadTeamWorkspace` analog). A gated
layout asks one question — *who is this user inside the tenant this URL names?* — and maps the answer to its
own navigation. The kernel returns a discriminated result, never redirects (framework‑agnostic):

```ts
const r = await resolveTenantWorkspace(runtime, slug, { minRole: 'staff' })
// { ok: true, workspace: { user, tenant, role } }
// | { ok: false, reason: 'unauthenticated' | 'not_found' | 'not_a_member' | 'forbidden' }
if (!r.ok) {
  if (r.reason === 'unauthenticated') redirect('/login')
  if (r.reason === 'not_found') notFound()
  redirect('/projects')                       // not_a_member / forbidden → back to the picker
}
```

Deliberately lean (`identity.getCurrentUser` + `getTenantBySlug` + `getMemberships` — no profile bootstrap,
no participant accounts); memoization is the app's concern (React `cache()` in an RSC world).

## 5. HTTP & error model

Promoted from both apps; the duplicate `jsonOk/jsonError` pair is resolved into one.

```ts
// @tenantkit/kernel/http
jsonOk<T>(data: T, init?: ResponseInit): Response                 // 200 { ...data }
jsonError(err: unknown): Response                                  // universal catch

class HttpError extends Error { status: number; code: string; details?: unknown }
const badRequest, unauthorized, forbidden, notFound, conflict,
      unprocessable, tooManyRequests, internal   // factories: e.g. forbidden('NOT_A_MEMBER')
```

`jsonError` maps, in order: `HttpError → {status, code, details}` · `DomainError → mapDomainError()` ·
**raw `PostgrestError`** by PG code (`42501→403`, `23505→409 CONFLICT`, `23514/P0001→422`, …) ·
`ZodError → 400 VALIDATION_ERROR` · fallback `500 INTERNAL`. Body shape is always
`{ error: string, code: string, details?, issues? }`, so the client toast layer is uniform.

`DomainError` (in `@reservation-core/domain`) carries a **stable code, no HTTP status** — the domain doesn't
know about HTTP. `mapDomainError` is the single bridge (e.g. `CreditExpired → 422 CREDIT_EXPIRED`).

## 6. Validation

```ts
// @tenantkit/kernel/validation
type ParseResult<T> = { success: true; data: T } | { success: false; response: Response }
parseJson<T>(req: Request, schema: ZodSchema<T>): Promise<ParseResult<T>>
parseQuery<T>(req: Request, schema): ParseResult<T>
parseHeaders<T>(req: Request, schema): ParseResult<T>
```

`withRoute({ body })` calls these for you; standalone use is the `isParseError(r) → return r.response`
pattern. Shared primitives (`emailSchema`, `phoneSchema`, `czPhoneSchema`, `slugSchema`, `dateOnlySchema`,
`localeSchema`) live in `@reservation-core/domain` so client forms and server routes validate identically.

## 7. Auth & identity (`requireClaims`)

```ts
// @tenantkit/kernel/auth
requireClaims(): Promise<AuthContext>        // cache()-wrapped per request; throws unauthorized()

interface AuthContext {
  userId: string
  email: string | null
  profile: ProfileClaims                     // display name, locale, avatar…
  memberships: Membership[]                  // { tenantId, role } — STAFF side
  participantAccounts: ParticipantAccount[]  // { participantId, relation } — FAMILY side
}
```

Key behaviors (lifted from `main-panel`'s `requireClaims`, generalized):

- **Idempotent profile bootstrap**: on first authenticated hit, ensure a `profiles` row exists (app‑code,
  guarded by a prior `select`). We *also* offer the DB‑trigger variant in `@reservation-core/db` for teams
  who prefer it; default is app‑code for testability.
- **Cached** with React `cache()` → one DB round‑trip per request regardless of how many components call it.
- A single account can be **both** staff (memberships) and family (participant accounts); the audience requested by
  the route decides which context is required.

**Active tenant** (staff): `active_tenant_id` httpOnly cookie, validated against `memberships`, defaulting to
the first membership; `POST /api/auth/switch-tenant` validates and sets it. (Generalized from
`activeRestaurant.ts` / `resolveActiveInstructor.ts`.)

See [05 — Auth](05-auth.md) for the full flows and provider config.

## 8. Tenancy

```ts
// @tenantkit/kernel/tenancy
defineTenancy(cfg): TenancyConfig
resolveTenant(ctx, from: TenantFrom): Promise<string | null>   // cookie | param | host | fn
assertMember(claims, tenantId): Membership                      // throws forbidden('NOT_A_MEMBER')
provisionTenant(input): Promise<{ tenantId: string }>           // SECURITY DEFINER RPC wrapper
```

- **Resolution** order for staff routes: explicit `param` → `host` (subdomain/custom domain) → `active_tenant_id`
  cookie. For public/portal surfaces, `host` (the `‹slug›.` subdomain) is primary.
- **Provisioning** uses a `SECURITY DEFINER` Postgres function `create_tenant_with_owner(name, slug)` that
  atomically inserts the tenant and the creator's `owner` membership (generalized from Restaurio's
  `create_restaurant_with_membership`). This avoids the RLS chicken‑and‑egg of "insert a tenant you're not
  yet a member of."

## 9. RBAC — roles + permissions

Two layers, both defined once and consumed by `withRoute` **and** RLS (see [04](04-roles-and-permissions.md)
for the catalogue):

```ts
// @reservation-core/domain/rbac
type AppRole = 'staff' | 'coach' | 'admin' | 'owner'      // rank 1..4
roleAtLeast(role: AppRole | null, min: AppRole): boolean

// fine-grained, format `resource:action:scope`  (scope = 'own' | 'any')
type Permission = `${string}:${string}` | `${string}:${string}:${'own'|'any'}`
can(role: AppRole, perm: Permission, ctx?: { ownerOf?: boolean }): boolean   // role → default grants
```

- The **role hierarchy** (`owner > admin > coach > staff`) is the common case and matches both reference apps
  (which use `owner > admin > employee`; we rename `employee→staff` and add `coach` for the course domain).
- The **permission catalogue** is an app‑extensible map of role → granted permissions, with `own`/`any`
  scoping (a coach edits *own* courses; an admin edits *any*). The same scope distinction becomes the RLS
  `USING` clause.

## 10. Entitlements (plan gating)

```ts
// @reservation-core/domain/entitlements + /server/entitlements
type Tier = string                                   // app-defined, e.g. 'free' | 'studio' | 'pro'
interface TierEntitlements { features: Record<FeatureKey, boolean | number>; }
const TIER_ENTITLEMENTS: Record<Tier, TierEntitlements>      // app supplies this map

getEntitlements(tier): TierEntitlements
checkEntitlements({ tier, features?, minTier? }): void        // throws UPGRADE_REQUIRED / FEATURE_NOT_AVAILABLE
createEntitlementsService(tier): EntitlementsService         // injected into RouteCtx
```

- Features are booleans **or numeric limits** (`maxCourses`, `maxStaff`, …).
- **Plugins are entitlements too**: `plugin:payments`, `plugin:sms` are feature keys, so a tier "owns" a
  plugin. The plugin guard (§12) checks *both* "tenant enabled it" and "tier entitles it."
- The **tier value** is materialized on the tenant row (`tenants.tier`), kept fresh by the `payments` plugin's
  Stripe webhooks; request‑time checks read the column (tolerate staleness), money‑time checks go live to
  Stripe. (Generalized from `main-panel`'s materialized‑tier + FDW design.)

## 11. Email (Resend)

```ts
// @tenantkit/kernel/email
sendEmail(input: SendEmailInput): Promise<EmailResult>      // ok | skipped (no key) | error — never throws into the request
interface SendEmailInput {
  to: string | string[]; template: EmailTemplate; locale: Locale
  data: Record<string, unknown>; idempotencyKey?: string; tags?: Record<string,string>
}
defineEmail<TData>(spec): EmailTemplate                     // localized subject + react/html renderer
```

- **Localized**: every template renders per `locale` (subject + body); the legacy "hardcoded English" mistake
  is impossible by construction.
- **Idempotent**: `idempotencyKey` forwarded to Resend; safe to call from retried webhooks.
- **Graceful**: missing `RESEND_API_KEY` → `skipped`, never an error in the user path (legacy lesson: a failed
  email must not break enrollment). Delivery status is recorded via the Resend webhook → `email_events`.
- Branding is per‑tenant (logo, from‑name, reply‑to) via a `TenantBranding` resolved at send time.

## 12. Plugin SDK — the extension model

The core's most strategic surface. A **plugin** is an optional, per‑tenant feature module. The legacy system
proved the *activation* idea (`TenantPluginActivation` + a `plugin_not_enabled` guard); we make it a real SDK
with documented **seams**. Full treatment in [09](09-plugins-and-subscriptions.md); the contract:

```ts
// @reservation-core/plugins
definePlugin(spec: PluginSpec): Plugin

interface PluginSpec {
  id: PluginId                              // 'payments' | 'sms' | 'booking-calendar' | 'ratings' | …
  name: LocalizedString
  requiresTier?: Tier                       // entitlement gate (e.g. payments needs 'pro')
  dbSchema?: string                         // plugins own a Postgres schema, never core tables
  routes?: PluginRouteModule               // mounted under /api/plugins/<id>/*
  events?: Partial<Record<CoreEvent, EventHandler>>   // subscribe to domain events
  uiSlots?: Partial<Record<UiSlot, ReactComponent>>   // inject into admin/portal slots
  settingsSchema?: ZodSchema               // per-tenant plugin config, edited in admin
  onEnable?(ctx: PluginLifecycleCtx): Promise<void>   // provision per-tenant resources
  onDisable?(ctx): Promise<void>
}
```

**Seams** (the only ways a plugin touches the system — keeps core decoupled):

1. **DB schema** — a plugin gets its own Postgres schema (`payments.*`, `sms.*`); it may *reference* core
   tables by id but never alter them. Its migrations live with the plugin package.
2. **Routes** — exported route handlers mounted at `/api/plugins/‹id›/…`, each already wrapped to assert the
   plugin is enabled+entitled.
3. **Events** — core emits domain events (`enrollment.created`, `attendance.excused`, `credit.issued`,
   `session.reminder_due`, …) on an outbox; plugins subscribe. The `sms` plugin listens to
   `session.reminder_due`; `payments` listens to `enrollment.created`.
4. **UI slots** — named injection points (`admin.course.tabs`, `portal.participant.actions`,
   `enrollment.form.extra`) rendered by `<PluginSlot name=…>` from `@reservation-core/ui-mantine`.
5. **Settings** — a Zod schema → an auto‑rendered settings form in the admin console; values stored per
   tenant in `plugin_settings`.

**The guard** (used by `withRoute({ plugin })` and inside plugin routes):

```ts
assertPluginEnabled(tenantId, pluginId): Promise<void>   // throws unprocessable('PLUGIN_NOT_ENABLED')
// passes only if: plugin_activations row is_enabled AND tenants.tier entitles `plugin:<id>`
```

## 13. i18n

```ts
// @reservation-core/i18n
createI18n({ locales: ['cs','en'], defaultLocale: 'cs' }): { routing, request, navigation }
```

A thin factory over next‑intl that returns the `routing` (`defineRouting`), `request` (`getRequestConfig`
loading `messages/‹locale›.json`), and locale‑aware `navigation` (`Link/redirect/usePathname/useRouter`).
This deletes the **config drift** found in Restaurio (two configs, `cs` vs `en` default). Message catalogues
are per‑app, namespaced (`admin.*`, `portal.*`, `enroll.*`, `email.*`); plugins ship their own namespace
(`plugins.payments.*`). Locale resolution: URL `[locale]` → user profile → tenant default → system default.

## 13a. Configurable fields (the `fields` module)

The kernel's **data‑driven form engine** — generic enough to live here, since every multi‑tenant SaaS collecting
records about *people* wants it. It turns a per‑tenant, surface‑aware field schema (`core.field_sets` +
`core.field_definitions`, [03 §4a](03-data-model.md)) into rendered forms + a validator, so the *Nový účastník*
modal, the public QR form, and the portal are **not hardcoded**. Full treatment in
[15](15-configurable-fields-and-settings.md); decision [ADR‑0011](adr/0011-configurable-field-schema.md). The
contract:

```ts
// @tenantkit/kernel  (fields)
applyPreset(preset: FieldPreset, tenantId: string): Promise<void>          // seed a tenant from an app preset
resolveFields(fields, { surface }): FieldDefinition[]                      // filter active + surface, sort by order
buildZodSchema(fields): ZodObject                                         // ONE validator — client + server (§6)
buildFormDescriptor(fields, locale): FormDescriptor                       // a localized, renderable form spec
splitValues(fields, values): { columns; custom }                          // partition a submit: spine ← columns, jsonb ← custom
mergeValues(...)                                                          // inverse, for loading a record into the edit form
// FieldDefinition{ key,label,help,type,target,required,options,validation,displayOrder,
//                  surfaces,isSystem,storage,columnName,pii,editableBy,source,active }
```

- **System spine vs. custom bag:** system fields (`isSystem`, `storage='column'`) map to typed columns
  (`participants.full_name`, `enrollments.payment_status`, …) for indexing/RLS/age/dedupe; custom fields
  (`storage='jsonb'`) live in the `participants.custom` / `enrollments.custom` bags. `splitValues` routes a
  submission accordingly — **not** EAV.
- **Three surfaces, one set:** `surfaces` (`admin_form`/`public_form`/`portal`) decide where each field shows;
  `resolveFields({surface})` filters. The same set drives all three forms.
- **Presets** (`kids-course` / `adult`) are the *app's* data; `applyPreset` seeds a new tenant, which then edits
  in **Settings → Pole účastníka** ([15 §6,§8](15-configurable-fields-and-settings.md)). A plugin may contribute
  fields (`source='plugin:<id>'`, e.g. `payments`→`payment_status`).
- **Validation parity:** `buildZodSchema` is the single schema used by both the client form and the route `body`
  (§6) — supersedes the legacy `custom_field_definitions` ([03 §4](03-data-model.md)).

## 14. Database building blocks (`@reservation-core/db`)

SQL the apps would otherwise copy‑paste. Crucially, this **DRYs the RLS membership check** that both
reference apps inline everywhere (and which caused Restaurio's "infinite recursion in policy" incident):

```sql
-- is_member_of: the ONE membership predicate, SECURITY DEFINER to avoid RLS recursion
create function core.is_member_of(p_tenant uuid, p_min_role text default 'staff')
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant and m.user_id = auth.uid()
      and core.role_rank(m.role) >= core.role_rank(p_min_role))
$$;

-- a table's tenant-isolation policy then reads (note: NO inline subquery, no recursion):
create policy tenant_rw on public.courses for all
  using (core.is_member_of(tenant_id))
  with check (core.is_member_of(tenant_id, 'coach'));
```

Also ships: `set_updated_at()` trigger, `core.role_rank()`, the `can_act_for_participant(participant)` predicate for
family RLS, and the **atomic capacity RPC pattern** (`SELECT … FOR UPDATE` to prevent overbooking, with
waitlist promotion) generalized from `main-panel`'s `marketplace_create_booking`. See [03](03-data-model.md)
and [08](08-attendance-and-omluvenky.md).

## 15. What an app must provide

To stand up a new product on the core, an app supplies a small `core.config.ts`:

```ts
export default defineApp({
  tenancy: defineTenancy({ tenantTable: 'tenants', membershipTable: 'memberships', tenantTerm: {…} }),
  roles: { hierarchy: ['staff','coach','admin','owner'], permissions: TERMINAR_PERMISSIONS },
  tiers: TIER_ENTITLEMENTS,                 // free | studio | pro
  i18n: { locales: ['cs','en'], defaultLocale: 'cs' },
  plugins: [payments, sms, bookingCalendar, ratings],
  email: { from: 'Termínář <no-reply@terminar.cz>', brandResolver },
  env: EnvSchema,
})
```

Everything else — the courses, the omluvenka logic, the screens — is the app's own domain, built with the
core's primitives. That domain is the subject of documents [03](03-data-model.md)–[12](12-api-surface.md).

---

### Reusability scorecard (what the core absorbs from the two existing apps)

| Capability | `main-panel` today | `admin-console` today | → `reservation-core` |
|---|---|---|---|
| Supabase 4‑client setup | ✔ (custom env name) | ✔ (custom env name) | ✔ parameterized |
| `withAuthRoute` | ✔ instructor‑coupled | ✔ restaurant‑coupled | ✔ `withRoute`, tenant‑agnostic |
| `requireClaims` + active‑tenant cookie | ✔ | ✔ | ✔ + family identity |
| HTTP/error stack | ✔ | ✔ (duplicated pair) | ✔ single |
| Zod validation kit | ✔ | ✔ | ✔ |
| Entitlements engine | ✔ | ✔ | ✔ + plugins‑as‑entitlements |
| Resend email | ✔ | ✗ (Edge fn) | ✔ localized |
| next‑intl | ✔ | ✔ (drifted) | ✔ single factory |
| RLS membership check | inline subquery | inline (recursion bug) | ✔ `is_member_of()` |
| Plugin activation + guard | (concept only) | ✗ | ✔ full SDK |
| Guardian/participant identity | ✗ | ✗ | ✔ new |

That last column is the deliverable: build it once, here.
