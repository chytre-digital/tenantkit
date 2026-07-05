/**
 * ★ Realizes docs/02-reservation-core.md §4 (withRoute) — the LEGACY route wrapper for ambient tenancy.
 *
 * A single wrapper that resolves identity, tenant, role, plugin-gating, entitlements, rate-limit, and
 * validation, then hands a typed `RouteCtx` to the handler. The generalization of both reference apps'
 * `withAuthRoute`, made tenant-agnostic.
 *
 * LEGACY (docs/17 §2): the staff tenant comes from an ambient chain — `tenantFrom` (param/host/cookie/fn)
 * with an unconditional fallback to the validated `active_tenant_id` cookie / first membership. That chain is
 * the Restaurio inheritance; slug-in-URL apps (Termínář-style `/projects/[slug]/…`) should use
 * `withSlugRoute` instead, which resolves the tenant from the route param for every audience. `withRoute`
 * remains fully supported for cookie/host (subdomain / custom-domain) tenancy.
 *
 * PORTS REFACTOR (docs/14): `withRoute` consumes a `CoreRuntime` (the ports bag) instead of importing
 * Supabase. `runtime` is a REQUIRED option — the app wires it once (see `apps/<app>/src/server/route.ts`) and
 * pre-binds a thin `route(opts, handler)`. The pipeline reaches the DB through `runtime.db.forRequest(req)`,
 * identity through `runtime.identity` (via `resolveClaims`), and the plugin/entitlement reads through
 * `runtime.authz`. The handler receives `ctx.db: RequestDb` (the three role-scoped handles) — NOT a vendor client.
 *
 * PIPELINE (doc 02 §4, doc 04 §8 — each step a clean early-return error; steps 6–10 live in route-pipeline.ts,
 * shared with withSlugRoute):
 *   1. runtime.db.forRequest(req)      → RLS-scoped handles into ctx.db
 *   2. resolve locale (cookie/header)  → ctx.locale
 *   3. audience !== 'public' ?         → resolveClaims(req, runtime)                401 UNAUTHORIZED
 *   4. staff:  resolve tenantId, assertMember, resolve role                        403 NOT_A_MEMBER
 *      family: resolve ParticipantContext                                          403 NOT_A_PARTICIPANT
 *   5. minRole / can                   → roleAtLeast + can()                       403 FORBIDDEN
 *   6. plugin                          → assertPluginEnabled (enabled+entitled)    422 PLUGIN_NOT_ENABLED
 *   7. entitlements                    → checkEntitlements()           403 UPGRADE_REQUIRED / FEATURE_NOT_AVAILABLE
 *   8. rateLimit                       → per-identity token bucket                 429 RATE_LIMITED
 *   9. body / query                    → parseJson / parseQuery into ctx.input     400 VALIDATION_ERROR
 *  10. run handler; any throw          → jsonError(e)
 */
import { jsonError } from '../http/respond'
import { forbidden } from '../http/errors'
import { resolveClaims } from '../auth/resolve-claims'
import { resolveTenant, resolveActiveTenant, assertMember, type TenantFrom } from '../tenancy'
import type { Tier } from '../entitlements'
import { resolveLocale } from './resolve-locale'
import { DEFAULT_LOCALE } from '../i18n/locale'
import {
  type Audience,
  type CommonRouteOptions,
  type RouteCtx,
  createBaseCtx,
  applyStaffContext,
  buildParticipantContext,
  enforceAuthorization,
  runPipelineTail,
  extractRequest,
} from './route-pipeline'

// The ctx/audience types moved to route-pipeline.ts (shared with withSlugRoute); re-exported here so the
// package barrel and existing consumers keep their import paths.
export type { Audience, ParticipantContext, RouteCtx } from './route-pipeline'

export interface RouteOptions<TArgs extends unknown[] = unknown[]> extends CommonRouteOptions {
  /** Who may call this. 'public' = no auth; 'staff' = tenant member; 'family' = participant account. */
  audience?: Audience // default 'staff'
  /** How to find the tenant for staff routes. */
  tenantFrom?: TenantFrom<TArgs>
  requireTenant?: boolean // default true for 'staff'
}

/**
 * Wrap a handler into a Next route export. `TArgs` are the trailing route args (the `Request` and Next's
 * `{ params }`), forwarded verbatim so the handler keeps its native signature.
 *
 * @deprecated LEGACY — the ambient-tenant wrapper (cookie/host/param chain, Restaurio/NaLekci-style). It
 * remains fully supported for cookie- and host-based (subdomain / custom-domain) tenancy. New slug-in-URL
 * apps should use `withSlugRoute`, which resolves the tenant from the `[slug]` route param for every
 * audience and never touches the active-tenant cookie.
 */
export function withRoute<TArgs extends unknown[]>(
  opts: RouteOptions<TArgs>,
  handler: (ctx: RouteCtx, ...args: TArgs) => Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  const audience: Audience = opts.audience ?? 'staff'
  const { runtime } = opts

  return async (...args: TArgs): Promise<Response> => {
    // The `Request` is the first arg Next passes; it keys both the DB handles and per-request claims memo.
    // Resolve it + the locale BEFORE the try so the catch can localize the error (cookie/header reads never throw).
    const req = extractRequest(args)
    const locale = req ? resolveLocale(req) : DEFAULT_LOCALE
    try {
      if (!req) {
        // Defensive: every Next route handler receives a Request. A wrapper with none is a programming error.
        throw new Error('[withRoute] no Request found in route args')
      }

      // 1. RLS-scoped handles (user/anon/service), identity derived from the request's session cookie.
      // 2. Locale (cookie/header) resolved above. No URL segment here — that's the page layer's concern.
      const ctx = createBaseCtx(runtime, runtime.db.forRequest(req), req, locale)

      // 3. Identity (skipped for public). Memoized per-request inside resolveClaims.
      if (audience !== 'public') {
        ctx.claims = await resolveClaims(req, runtime) // throws 401 UNAUTHORIZED if no session
      }

      // 4. Tenant + role (staff) / participant (family).
      if (audience === 'staff') {
        await resolveStaffContext(ctx, opts, args)
      } else if (audience === 'family') {
        ctx.participant = buildParticipantContext(ctx.claims!) // throws 403 NOT_A_PARTICIPANT
      }

      // 5. minRole / can — coarse rank AND fine permission (staff only).
      if (audience === 'staff') {
        enforceAuthorization(ctx, opts)
      }

      // 6–10. Shared tail: plugin → entitlements → rate limit → body/query → run (route-pipeline.ts).
      return await runPipelineTail(ctx, opts, args, handler)
    } catch (e) {
      // Any throw — HttpError / DomainError / PostgrestError / ZodError / unknown — becomes a uniform response,
      // localized to the request locale resolved above.
      return jsonError(e, locale)
    }
  }
}

async function resolveStaffContext<TArgs extends unknown[]>(
  ctx: RouteCtx,
  opts: RouteOptions<TArgs>,
  args: TArgs,
): Promise<void> {
  const claims = ctx.claims!
  const requireTenant = opts.requireTenant ?? true

  // Resolution order: explicit tenantFrom → active-tenant cookie fallback (doc 02 §8).
  let tenantId: string | null = null
  if (opts.tenantFrom) tenantId = await resolveTenant(opts.tenantFrom, args, ctx.req)
  tenantId ??= resolveActiveTenant(claims, ctx.req)

  if (!tenantId) {
    if (requireTenant) throw forbidden('NOT_A_MEMBER', 'No tenant resolved for this request')
    return
  }

  const membership = assertMember(claims, tenantId) // throws 403 NOT_A_MEMBER

  // Tier is materialized on the tenant row (doc 09 §3.3) — read it via the authz port to build entitlements.
  const tier = (await ctx.runtime.authz.getTenantTier(tenantId)) as Tier
  applyStaffContext(ctx, tenantId, membership.role, tier)
}
