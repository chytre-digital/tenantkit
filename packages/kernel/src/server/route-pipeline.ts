/**
 * INTERNAL — the shared spine of the route wrappers. Not exported from the package barrel.
 *
 * `withRoute` (legacy cookie/host/param tenancy) and `withSlugRoute` (URL-slug tenancy, docs/17 §2) differ
 * ONLY in how they resolve the tenant (pipeline step 4). Everything else — the ctx shape, the authorization
 * gate, and the pipeline tail (plugin → entitlements → rate limit → validation → run) — lives here once, so
 * the two wrappers cannot drift apart. Moved verbatim out of with-route.ts; behavior is unchanged.
 */
import type { ZodSchema } from 'zod'
import type { CoreRuntime, RequestDb } from '../ports'
import { forbidden } from '../http/errors'
import { parseJson, parseQuery, isParseError } from '../validation/parse'
import type { AuthContext } from '../auth/resolve-claims'
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
import type { Locale } from '../i18n/locale'
import { zodErrorMap } from '../i18n/zod-locale'

export type Audience = 'public' | 'staff' | 'family'

/** PARTICIPANT (family) identity: the participant ids this account may act for (doc 02 §4, doc 04 §7). */
export interface ParticipantContext {
  userId: string
  participantIds: string[]
  canActFor(participantId: string): boolean
}

/** The policy options every wrapper shares — pipeline steps 5–9. Tenant resolution is the wrapper's own. */
export interface CommonRouteOptions {
  /** The wired ports bag. REQUIRED — the app builds it once and pre-binds `route()` (docs/14). */
  runtime: CoreRuntime
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
  participant: ParticipantContext | null // when audience === 'family'
  // parsed inputs (typed via opts.body / opts.query):
  input: { body?: TBody; query?: TQuery }
}

/** Pipeline steps 1–2 result → the empty ctx every wrapper starts from. */
export function createBaseCtx(runtime: CoreRuntime, db: RequestDb, req: Request, locale: Locale): RouteCtx {
  return {
    runtime,
    db,
    req,
    locale,
    claims: null,
    tenantId: null,
    role: null,
    can: () => false,
    entitlements: null,
    participant: null,
    input: {},
  }
}

/**
 * Fill the staff side of ctx from a PROVEN membership: tenantId, role, entitlements(tier), can().
 * ctx.can() closes over role + the caller's per-row ownership (coach_assignments). `ownerOf` is resolved
 * lazily by the use-case in the real impl; here can() answers role-level grants and admins/owners' `any`.
 */
export function applyStaffContext(ctx: RouteCtx, tenantId: string, role: AppRole, tier: Tier): void {
  ctx.tenantId = tenantId
  ctx.role = role
  ctx.entitlements = createEntitlementsService(tier)
  ctx.can = (perm: Permission) => evalCan(ctx.role!, perm, { ownerOf: undefined })
}

/**
 * Build the family-audience ParticipantContext from claims. With `tenantId`, only participant links IN that
 * tenant count (the slug wrapper's tenant-scoped portal — doc 04 §7); without it, all links count (legacy
 * withRoute behavior). Throws `403 NOT_A_PARTICIPANT` when empty either way.
 * Family routes never take minRole/can — scope IS the participant link (doc 04 §7); RLS enforces the same.
 */
export function buildParticipantContext(claims: AuthContext, tenantId?: string): ParticipantContext {
  const accounts = tenantId
    ? claims.participantAccounts.filter((p) => p.tenantId === tenantId)
    : claims.participantAccounts
  if (accounts.length === 0) {
    throw forbidden(
      'NOT_A_PARTICIPANT',
      tenantId ? 'This account has no participants in this tenant' : 'This account has no participants',
    ) // doc 04 §8
  }
  const participantIds = accounts.map((p) => p.participantId)
  const set = new Set(participantIds)
  return {
    userId: claims.userId,
    participantIds,
    canActFor: (id) => set.has(id),
  }
}

/** Pipeline step 5 — coarse rank AND fine permission (staff only). */
export function enforceAuthorization(
  ctx: RouteCtx,
  opts: Pick<CommonRouteOptions, 'minRole' | 'can'>,
): void {
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

/**
 * Pipeline steps 6–10, shared verbatim between the wrappers:
 *   6. plugin        → assertPluginEnabled (enabled+entitled)    422 PLUGIN_NOT_ENABLED
 *   7. entitlements  → checkEntitlements()          403 UPGRADE_REQUIRED / FEATURE_NOT_AVAILABLE
 *   8. rateLimit     → per-identity token bucket                 429 RATE_LIMITED
 *   9. body / query  → parseJson / parseQuery into ctx.input     400 VALIDATION_ERROR (returned, not thrown)
 *  10. run handler (throws bubble to the wrapper's catch → jsonError)
 */
export async function runPipelineTail<TArgs extends unknown[]>(
  ctx: RouteCtx,
  opts: CommonRouteOptions,
  args: TArgs,
  handler: (ctx: RouteCtx, ...args: TArgs) => Promise<Response>,
): Promise<Response> {
  const { runtime } = opts

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
  const errorMap = zodErrorMap(ctx.locale)
  if (opts.body) {
    const r = await parseJson(ctx.req, opts.body, errorMap)
    if (isParseError(r)) return r.response // 400 VALIDATION_ERROR
    ctx.input.body = r.data
  }
  if (opts.query) {
    const r = parseQuery(ctx.req, opts.query, errorMap)
    if (isParseError(r)) return r.response
    ctx.input.query = r.data
  }

  // 10. Run.
  return handler(ctx, ...args)
}

/** Compose the rate-limit identity from IP + the authenticated subject (or 'anon' for public flows). */
export function rateLimitIdentity(ctx: RouteCtx, args: unknown[]): string {
  const req = extractRequest(args)
  const ip = req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown-ip'
  const subject = ctx.claims?.userId ?? ctx.claims?.email ?? 'anon'
  return `${ip}|${subject}`
}

/** Pull the `Request` out of the route args (it's the first arg Next passes a handler). */
export function extractRequest(args: unknown[]): Request | undefined {
  return args.find((a): a is Request => a instanceof Request)
}
