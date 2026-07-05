/**
 * resolveTenantWorkspace — the PAGE-layer companion of `withSlugRoute` (docs/17 §2: Makerkit's
 * `loadTeamWorkspace` analog). A layout / server component guarding `/projects/[slug]/…` asks one question —
 * "who is this user inside the tenant this URL names?" — and maps the answer to its own navigation
 * (redirect to login, notFound, bounce to the picker). The kernel stays framework-agnostic, so this returns a
 * discriminated result instead of redirecting; the app decides what each reason means.
 *
 * Deliberately LEAN: `identity.getCurrentUser` + `authz.getTenantBySlug` + `authz.getMemberships` — no
 * `resolveClaims` (no profile bootstrap, no participant accounts). It mirrors what a gated layout actually
 * needs, nothing more. Memoization is the app's concern (React `cache()` in an RSC world).
 *
 * The `req` option exists for adapters that truly read the passed Request. Cookie-store adapters (the
 * Supabase reference adapter reads next/headers cookies) ignore the argument, so RSCs — which have no
 * Request — may omit it; a syntactically valid placeholder is used to satisfy the port signature.
 */
import type { CoreRuntime, TenantSummary } from '../ports'
import { roleAtLeast, type AppRole } from '../rbac/roles'

export interface TenantWorkspace {
  user: { id: string; email: string | null }
  tenant: TenantSummary
  role: AppRole
}

export type WorkspaceResult =
  | { ok: true; workspace: TenantWorkspace }
  | { ok: false; reason: 'unauthenticated' | 'not_found' | 'not_a_member' | 'forbidden' }

/**
 * Resolve the caller's workspace for a tenant slug. Check order mirrors withSlugRoute's guard ladder:
 * `unauthenticated` (no session) → `not_found` (unknown slug) → `not_a_member` (no membership) →
 * `forbidden` (member, but below `opts.minRole`).
 */
export async function resolveTenantWorkspace(
  runtime: CoreRuntime,
  slug: string,
  opts?: { minRole?: AppRole; req?: Request },
): Promise<WorkspaceResult> {
  const req = opts?.req ?? new Request('http://localhost')
  const user = await runtime.identity.getCurrentUser(req)
  if (!user) return { ok: false, reason: 'unauthenticated' }

  const tenant = await runtime.authz.getTenantBySlug(slug)
  if (!tenant) return { ok: false, reason: 'not_found' }

  const memberships = await runtime.authz.getMemberships(user.id)
  const membership = memberships.find((m) => m.tenantId === tenant.id)
  if (!membership) return { ok: false, reason: 'not_a_member' }

  const role = membership.role as AppRole
  if (opts?.minRole && !roleAtLeast(role, opts.minRole)) return { ok: false, reason: 'forbidden' }

  return { ok: true, workspace: { user: { id: user.id, email: user.email }, tenant, role } }
}
