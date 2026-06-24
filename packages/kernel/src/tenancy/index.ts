/**
 * Realizes docs/02-reservation-core.md §8 and docs/05-auth.md §2(a) — tenancy.
 *
 * The ONE coupling the core generalizes: the tenant noun. An app declares its taxonomy once with
 * `defineTenancy` (`tenantTable`/`membershipTable`/`tenantTerm`); NaLekci would pass `instructors`, Restaurio
 * `restaurants`. Everything else — resolution, the active-tenant cookie, membership assertion, provisioning —
 * is tenant-agnostic.
 *
 * Resolution order (staff): explicit `param` → `host` (subdomain/custom domain) → `active_tenant_id` cookie.
 * `provisionTenant` wraps the `create_tenant_with_owner` SECURITY DEFINER RPC to dodge the RLS chicken-and-egg
 * of "insert a tenant you're not yet a member of" (doc 02 §8).
 */
import { forbidden } from '../http/errors'
import { readCookie } from '../i18n/locale'
import type { CoreRuntime } from '../ports'
import type { AuthContext, Membership } from '../auth/resolve-claims'

export type Promisable<T> = T | Promise<T>

export interface LocalizedTerm {
  one: string
  cs: string
  [locale: string]: string
}

export interface TenancyConfig {
  tenantTable: string // e.g. 'tenants'
  membershipTable: string // e.g. 'memberships'
  tenantTerm: LocalizedTerm // e.g. { one: 'studio', cs: 'studio' }
  /** Name of the SECURITY DEFINER provisioning RPC (doc 02 §8). */
  provisionFn?: string // default 'create_tenant_with_owner'
}

const ACTIVE_TENANT_COOKIE = 'active_tenant_id'

let CONFIG: TenancyConfig = {
  tenantTable: 'tenants',
  membershipTable: 'memberships',
  tenantTerm: { one: 'tenant', cs: 'tenant' },
  provisionFn: 'create_tenant_with_owner',
}

/** App wiring (doc 02 §15): `defineTenancy({ tenantTable, membershipTable, tenantTerm })`. */
export function defineTenancy(cfg: Partial<TenancyConfig>): TenancyConfig {
  CONFIG = { ...CONFIG, ...cfg }
  return CONFIG
}

export function tenancyConfig(): TenancyConfig {
  return CONFIG
}

/** Where to find the tenant for a route (doc 02 §4). The function form lets a route compute it from args. */
export type TenantFrom<TArgs extends unknown[] = unknown[]> =
  | 'cookie'
  | 'param'
  | 'host'
  | ((...args: TArgs) => Promisable<string | null>)

/**
 * Resolve the tenant id for a staff route. `param`/`host` read from the request context; `cookie` reads the
 * validated active-tenant cookie; a function is invoked with the route args. Returns null when unresolved.
 */
export async function resolveTenant<TArgs extends unknown[]>(
  from: TenantFrom<TArgs>,
  args: TArgs,
  req: Request,
): Promise<string | null> {
  if (typeof from === 'function') return from(...args)
  switch (from) {
    case 'param':
      return tenantIdFromParam(args)
    case 'host':
      return tenantIdFromHost(req)
    case 'cookie':
      return readActiveTenantCookie(req)
    default:
      return null
  }
}

/** Pull a tenant id out of Next's `{ params }` arg (`/t/[tenantId]` or `tenantId` search param). */
function tenantIdFromParam(args: unknown[]): string | null {
  const ctx = args.find(
    (a): a is { params: Record<string, string> } =>
      typeof a === 'object' && a !== null && 'params' in a,
  )
  const params = ctx?.params ?? {}
  return params.tenantId ?? params.tenant ?? null
}

/**
 * Map the request host to a tenant. The app's `proxy.ts` extracts the `‹slug›.` subdomain (or a custom domain)
 * into a header (doc 01 §7); a custom domain is looked up in `core.tenant_domains`. Slug→id resolution is a // …
 * cheap cached read; sketched here as reading the header the middleware set.
 */
function tenantIdFromHost(req: Request): string | null {
  // proxy.ts sets this header after parsing host/path (doc 01 §7).
  return req.headers.get('x-tenant-id') ?? null
}

/** Read the active-tenant cookie (raw) off the Request. Validate against memberships before trusting. */
export function readActiveTenantCookie(req: Request): string | null {
  return readCookie(req.headers.get('cookie'), ACTIVE_TENANT_COOKIE)
}

/**
 * Append the active-tenant `Set-Cookie` to a Response (framework-agnostic). httpOnly + SameSite=Lax (doc 05 §2a).
 * The caller MUST have validated the tenant is in the user's memberships first; `POST /api/auth/switch-tenant`
 * does exactly that.
 */
export function setActiveTenantCookie(res: Response, tenantId: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.headers.append(
    'set-cookie',
    `${ACTIVE_TENANT_COOKIE}=${encodeURIComponent(tenantId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secure}`,
  )
}

/**
 * Resolve the active tenant for a staff request: the cookie value if it's a real membership, else the first
 * membership (a cookie pointing at a tenant the user left silently falls back — doc 05 §2a). Null when the
 * user has no memberships at all (→ onboarding).
 */
export function resolveActiveTenant(claims: AuthContext, req: Request): string | null {
  const cookieValue = readActiveTenantCookie(req)
  const isMember = (id: string | null) => !!id && claims.memberships.some((m) => m.tenantId === id)
  if (isMember(cookieValue)) return cookieValue
  return claims.memberships[0]?.tenantId ?? null
}

/**
 * Assert the caller is a member of `tenantId`; returns the `Membership` (with its role) or throws
 * `403 NOT_A_MEMBER`. The DB RLS `is_member_of()` is the second gate (doc 03 §7) — belt and suspenders.
 */
export function assertMember(claims: AuthContext, tenantId: string): Membership {
  const membership = claims.memberships.find((m) => m.tenantId === tenantId)
  if (!membership) throw forbidden('NOT_A_MEMBER', 'You are not a member of this tenant')
  return membership
}

export interface ProvisionTenantInput {
  name: string
  slug: string
  ownerUserId: string
}

/**
 * Provision a tenant + the creator's `owner` membership atomically via the SECURITY DEFINER RPC
 * `create_tenant_with_owner(name, slug)` (doc 02 §8). PORTS REFACTOR (docs/14): the privileged write now goes
 * through `runtime.authz.provisionTenant` — the adapter owns the service-role call to the RPC (which re-checks
 * the caller). Generalized from Restaurio's `create_restaurant_with_membership`.
 */
export async function provisionTenant(
  runtime: CoreRuntime,
  input: ProvisionTenantInput,
): Promise<{ tenantId: string }> {
  // The provisioning RPC name is fixed by the adapter; `CONFIG.provisionFn` documents the app's expectation.
  // A DB error bubbles to jsonError → PG-code map (e.g. 23505 slug taken → 409 CONFLICT).
  return runtime.authz.provisionTenant({
    name: input.name,
    slug: input.slug,
    ownerId: input.ownerUserId,
  })
}
