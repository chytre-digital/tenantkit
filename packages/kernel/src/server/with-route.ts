/**
 * ★ Realizes docs/02-reservation-core.md §4 (withRoute) — the ONE way to write an endpoint.
 *
 * A single wrapper that resolves identity, tenant, role, plugin-gating, entitlements, rate-limit, and
 * validation, then hands a typed `RouteCtx` to the handler. Every API route uses it. The generalization of
 * both reference apps' `withAuthRoute`, made tenant-agnostic.
 *
 * PORTS REFACTOR (docs/14): `withRoute` now consumes a `CoreRuntime` (the ports bag) instead of importing
 * Supabase. `runtime` is a REQUIRED option — the app wires it once (see `apps/<app>/src/server/route.ts`) and
 * pre-binds a thin `route(opts, handler)`. The pipeline reaches the DB through `runtime.db.forRequest(req)`,
 * identity through `runtime.identity` (via `resolveClaims`), and the plugin/entitlement reads through
 * `runtime.authz`. The handler receives `ctx.db: RequestDb` (the three role-scoped handles) — NOT a vendor client.
 *
 * PIPELINE (doc 02 §4, doc 04 §8 — each step a clean early-return error):
 *   1. runtime.db.forRequest(req)      → RLS-scoped handles into ctx.db
 *   2. resolve locale (cookie/header)  → ctx.locale
 *   3. audience !== 'public' ?         → resolveClaims(req, runtime)                401 UNAUTHORIZED
 *   4. staff:  resolve tenantId, assertMember, resolve role                        403 NOT_A_MEMBER
 *      family: resolve GuardianContext                                            403 NOT_A_GUARDIAN
 *   5. minRole / can                   → roleAtLeast + can()                       403 FORBIDDEN
 *   6. plugin                          → assertPluginEnabled (enabled+entitled)    422 PLUGIN_NOT_ENABLED
 *   7. entitlements                    → checkEntitlements()           403 UPGRADE_REQUIRED / FEATURE_NOT_AVAILABLE
 *   8. rateLimit                       → per-identity token bucket                 429 RATE_LIMITED
 *   9. body / query                    → parseJson / parseQuery into ctx.input     400 VALIDATION_ERROR
 *  10. run handler; any throw          → jsonError(e)
 */
import type { ZodSchema } from 'zod'
import type { CoreRuntime, RequestDb } from '../ports'
import { jsonError } from '../http/respond'
import { forbidden } from '../http/errors'
import { parseJson, parseQuery, isParseError } from '../validation/parse'
import { resolveClaims, type AuthContext } from '../auth/resolve-claims'
import {
  resolveTenant,
  resolveActiveTenant,
  assertMember,
  type TenantFrom,
} from '../tenancy'
import { roleAtLeast, type AppRole } from '../rbac/roles'
import { can as evalCan, type Permission } from '../rbac/permissions'
import {
  createEntitlementsService,
  checkEntitlements,
  type EntitlementsService,
  type FeatureKey,
  type Tier,
} from '../entitlements'
import { assertPluginEnabled } from '../plugins/guard'
import type { PluginId } from '../plugins/define-plugin'
import { enforceRateLimit, type RateLimitSpec } from '../http/rate-limit'
import { resolveLocale } from './resolve-locale'
import { type Locale, DEFAULT_LOCALE } from '../i18n/locale'
import { zodErrorMap } from '../i18n/zod-locale'

export type Audience = 'public' | 'staff' | 'family'

/** FAMILY identity: the participant ids this account may act for (doc 02 §4, doc 04 §7). */
export interface GuardianContext {
  userId: string
  participantIds: string[]
  canActFor(participantId: string): boolean
}

export interface RouteOptions<TArgs extends unknown[] = unknown[]> {
  /** The wired ports bag. REQUIRED — the app builds it once and pre-binds `route()` (docs/14). */
  runtime: CoreRuntime
  /** Who may call this. 'public' = no auth; 'staff' = tenant member; 'family' = guardian/participant. */
  audience?: Audience // default 'staff'
  /** How to find the tenant for staff routes. */
  tenantFrom?: TenantFrom<TArgs>
  requireTenant?: boolean // default true for 'staff'
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
  /** Validate the request body/query; the parsed value is passed to the handler via ctx.input. */
  body?: ZodSchema
  query?: ZodSchema
}

export interface RouteCtx<TBody = unknown, TQuery = unknown> {
  /** The wired ports bag — handlers use it for email/payments/ids/clock when they need a port directly. */
  runtime: CoreRuntime
  /** The three role-scoped DB handles for this request (`runtime.db.forRequest(req)`). RLS-scoped to the caller. */
  db: RequestDb
  /** The incoming `Request` (the first arg Next passes the handler). */
  req: Request
  locale: Locale
  // staff:
  claims: AuthContext | null // null for 'public'
  tenantId: string | null
  role: AppRole | null
  can: (perm: Permission) => boolean
  entitlements: EntitlementsService | null
  // family:
  guardian: GuardianContext | null // when audience === 'family'
  // parsed inputs (typed via opts.body / opts.query):
  input: { body?: TBody; query?: TQuery }
}

/**
 * Wrap a handler into a Next route export. `TArgs` are the trailing route args (the `Request` and Next's
 * `{ params }`), forwarded verbatim so the handler keeps its native signature.
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
      const db = runtime.db.forRequest(req)

      // 2. Locale (cookie/header) resolved above. No URL segment here — that's the page layer's concern.

      const ctx: RouteCtx = {
        runtime,
        db,
        req,
        locale,
        claims: null,
        tenantId: null,
        role: null,
        can: () => false,
        entitlements: null,
        guardian: null,
        input: {},
      }

      // 3. Identity (skipped for public). Memoized per-request inside resolveClaims.
      if (audience !== 'public') {
        ctx.claims = await resolveClaims(req, runtime) // throws 401 UNAUTHORIZED if no session
      }

      // 4. Tenant + role (staff) / guardian (family).
      if (audience === 'staff') {
        await resolveStaffContext(ctx, opts, args)
      } else if (audience === 'family') {
        resolveFamilyContext(ctx)
      }

      // 5. minRole / can — coarse rank AND fine permission (staff only).
      if (audience === 'staff') {
        enforceAuthorization(ctx, opts)
      }

      // 6. Plugin gate — enabled AND entitled.
      if (opts.plugin && ctx.tenantId) {
        await assertPluginEnabled(runtime, ctx.tenantId, opts.plugin) // throws 422 PLUGIN_NOT_ENABLED
      }

      // 7. Declarative entitlements (independent of a plugin).
      if (opts.entitlements && ctx.entitlements) {
        checkEntitlements({
          tier: ctx.entitlements.tier,
          features: opts.entitlements.features,
          minTier: opts.entitlements.minTier,
        }) // throws 403 UPGRADE_REQUIRED / FEATURE_NOT_AVAILABLE
      }

      // 8. Rate limit (per identity) — counter store reached through the runtime's service handle.
      if (opts.rateLimit) {
        await enforceRateLimit(runtime, opts.rateLimit, rateLimitIdentity(ctx, args)) // throws 429 RATE_LIMITED
      }

      // 9. Body / query validation → ctx.input. Localize Zod's built-in messages via the request locale.
      const errorMap = zodErrorMap(locale)
      if (opts.body) {
        const r = await parseJson(req, opts.body, errorMap)
        if (isParseError(r)) return r.response // 400 VALIDATION_ERROR
        ctx.input.body = r.data
      }
      if (opts.query) {
        const r = parseQuery(req, opts.query, errorMap)
        if (isParseError(r)) return r.response
        ctx.input.query = r.data
      }

      // 10. Run.
      return await handler(ctx, ...args)
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
  ctx.tenantId = tenantId
  ctx.role = membership.role

  // Tier is materialized on the tenant row (doc 09 §3.3) — read it via the authz port to build entitlements.
  const tier = (await ctx.runtime.authz.getTenantTier(tenantId)) as Tier
  ctx.entitlements = createEntitlementsService(tier)

  // ctx.can() closes over role + the caller's per-row ownership (coach_assignments). `ownerOf` is resolved
  // lazily by the use-case in the real impl; here can() answers role-level grants and admins/owners' `any`.
  ctx.can = (perm: Permission) => evalCan(ctx.role!, perm, { ownerOf: undefined })
}

function resolveFamilyContext(ctx: RouteCtx): void {
  const claims = ctx.claims!
  if (claims.guardianships.length === 0) {
    throw forbidden('NOT_A_GUARDIAN', 'This account has no participants') // doc 04 §8
  }
  const participantIds = claims.guardianships.map((g) => g.participantId)
  const set = new Set(participantIds)
  ctx.guardian = {
    userId: claims.userId,
    participantIds,
    canActFor: (id) => set.has(id),
  }
  // Family routes never take minRole/can — scope IS the guardianship (doc 04 §7); RLS enforces the same.
}

function enforceAuthorization<TArgs extends unknown[]>(ctx: RouteCtx, opts: RouteOptions<TArgs>): void {
  if (opts.minRole && !roleAtLeast(ctx.role, opts.minRole)) {
    throw forbidden('FORBIDDEN', `Requires role ${opts.minRole} or higher`)
  }
  if (opts.can) {
    const perms = Array.isArray(opts.can) ? opts.can : [opts.can]
    for (const perm of perms) {
      if (!ctx.can(perm)) throw forbidden('FORBIDDEN', `Missing permission ${perm}`)
    }
  }
}

/** Compose the rate-limit identity from IP + the authenticated subject (or 'anon' for public flows). */
function rateLimitIdentity<TArgs extends unknown[]>(ctx: RouteCtx, args: TArgs): string {
  const req = extractRequest(args)
  const ip = req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown-ip'
  const subject = ctx.claims?.userId ?? ctx.claims?.email ?? 'anon'
  return `${ip}|${subject}`
}

/** Pull the `Request` out of the route args (it's the first arg Next passes a handler). */
function extractRequest(args: unknown[]): Request | undefined {
  return args.find((a): a is Request => a instanceof Request)
}
