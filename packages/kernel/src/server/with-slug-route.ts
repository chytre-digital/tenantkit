/**
 * ★ withSlugRoute — the URL-addressable tenancy wrapper (docs/17 §2: the Makerkit-style selector).
 *
 * The tenant is named IN the route (`/projects/[slug]/…`), never by ambient state: the wrapper reads the
 * `[slug]` route param, resolves it through `runtime.authz.getTenantBySlug`, and 404s when it doesn't exist —
 * for EVERY audience, public included (a public enrollment form is still a *tenant's* form). No active-tenant
 * cookie is read or written; the path IS the selector. This is the recommended wrapper for new apps;
 * `withRoute` remains the legacy path for cookie/host (subdomain / custom-domain) tenancy.
 *
 * PIPELINE (steps 6–10 shared verbatim with withRoute via route-pipeline.ts):
 *   1. runtime.db.forRequest(req)      → RLS-scoped handles into ctx.db
 *   2. resolve locale (cookie/header)  → ctx.locale
 *   3. audience !== 'public' ?         → resolveClaims(req, runtime)                401 UNAUTHORIZED
 *   4. await params → slug → getTenantBySlug                                        404 NOT_FOUND
 *      staff:  assertMember, role, entitlements from tenant.tier (no extra read)    403 NOT_A_MEMBER
 *      family: ParticipantContext scoped to THIS tenant                             403 NOT_A_PARTICIPANT
 *   5. minRole / can                   → roleAtLeast + can()                        403 FORBIDDEN
 *   6.–10. plugin / entitlements / rateLimit / body+query / run    (see route-pipeline.ts)
 *
 * Guard order is 401 → 404 → 403: identity precedes the slug lookup, so an anonymous probe learns nothing
 * about which slugs exist; a signed-in non-member gets 403 on a real slug, 404 on a bogus one.
 */
import { jsonError } from '../http/respond'
import { notFound } from '../http/errors'
import { resolveClaims } from '../auth/resolve-claims'
import { assertMember, tenancyConfig } from '../tenancy'
import type { TenantSummary } from '../ports'
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

/** Unlike RouteOptions<TArgs>, no option here depends on the route args (there is no `tenantFrom` fn) — plain interface. */
export interface SlugRouteOptions extends CommonRouteOptions {
  /** Who may call this. The tenant is resolved from the slug for EVERY audience. Default 'staff'. */
  audience?: Audience
  /** Route-param key holding the tenant slug, i.e. the `[slug]` segment name. Default 'slug'. */
  slugParam?: string
}

/** RouteCtx narrowed: the tenant is ALWAYS resolved (an unknown slug already 404'd before the handler). */
export interface SlugRouteCtx<TBody = unknown, TQuery = unknown> extends RouteCtx<TBody, TQuery> {
  tenant: TenantSummary
  tenantId: string
}

/**
 * Wrap a handler into a Next route export, tenant-addressed by the URL slug. `TArgs` are the trailing route
 * args (the `Request` and Next's `{ params }`), forwarded verbatim so the handler keeps its native signature.
 */
export function withSlugRoute<TArgs extends unknown[]>(
  opts: SlugRouteOptions,
  handler: (ctx: SlugRouteCtx, ...args: TArgs) => Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  const audience: Audience = opts.audience ?? 'staff'
  const { runtime } = opts

  return async (...args: TArgs): Promise<Response> => {
    // Resolve Request + locale BEFORE the try so the catch can localize the error.
    const req = extractRequest(args)
    const locale = req ? resolveLocale(req) : DEFAULT_LOCALE
    try {
      if (!req) {
        // Defensive: every Next route handler receives a Request. A wrapper with none is a programming error.
        throw new Error('[withSlugRoute] no Request found in route args')
      }

      // 1.–2. RLS-scoped handles + locale.
      const ctx = createBaseCtx(runtime, runtime.db.forRequest(req), req, locale) as SlugRouteCtx

      // 3. Identity FIRST for staff/family → 401 (keeps the 401 → 404 → 403 guard order).
      if (audience !== 'public') {
        ctx.claims = await resolveClaims(req, runtime) // throws 401 UNAUTHORIZED if no session
      }

      // 4. Tenant from the URL slug — for ALL audiences. Unknown slug → 404 (code NOT_FOUND, so the
      // localized error catalog supplies the cs/en body; the message is the uncatalogued-locale fallback).
      const slug = await extractSlugParam(args, opts.slugParam ?? 'slug')
      const tenant = await runtime.authz.getTenantBySlug(slug)
      if (!tenant) {
        throw notFound('NOT_FOUND', `No ${tenancyConfig().tenantTerm.one} for slug "${slug}"`)
      }
      ctx.tenant = tenant
      ctx.tenantId = tenant.id // compat: everything keyed on ctx.tenantId keeps working

      // 4b.–5. Audience-specific authorization inside the resolved tenant.
      if (audience === 'staff') {
        const membership = assertMember(ctx.claims!, tenant.id) // throws 403 NOT_A_MEMBER
        // Entitlements come from the row we already fetched — no getTenantTier round-trip.
        applyStaffContext(ctx, tenant.id, membership.role, tenant.tier as Tier)
        enforceAuthorization(ctx, opts) // throws 403 FORBIDDEN (minRole / can)
      } else if (audience === 'family') {
        ctx.participant = buildParticipantContext(ctx.claims!, tenant.id) // throws 403 NOT_A_PARTICIPANT
      }

      // 6.–10. Shared tail: plugin → entitlements → rate limit → body/query → run (route-pipeline.ts).
      // Note: opts.plugin now gates PUBLIC slug routes too — ctx.tenantId is set for every audience.
      return await runPipelineTail(ctx, opts, args, handler as (ctx: RouteCtx, ...a: TArgs) => Promise<Response>)
    } catch (e) {
      return jsonError(e, locale)
    }
  }
}

/**
 * Pull the tenant slug out of Next's `{ params }` route arg. Next 15/16 pass `params` as a Promise —
 * `await` handles both the Promise and the plain-object (older Next, tests) shapes; a Promise can safely be
 * awaited again by the handler for its other keys. A missing key is a programming error (the file isn't under
 * a `[slug]` segment / `slugParam` is misspelled), not a 404.
 */
async function extractSlugParam(args: unknown[], key: string): Promise<string> {
  const holder = args.find(
    (a): a is { params: unknown } => typeof a === 'object' && a !== null && 'params' in a,
  )
  if (!holder) {
    throw new Error('[withSlugRoute] no { params } in route args — is this route under a [slug] segment?')
  }
  const params = (await Promise.resolve(holder.params)) as Record<string, unknown> | null | undefined
  const value = params?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[withSlugRoute] route params have no "${key}" — check the [${key}] segment / opts.slugParam`)
  }
  return value
}
