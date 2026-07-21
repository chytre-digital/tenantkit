/**
 * withSlugRoute behavior suite (docs/17 §2 — the URL-addressable tenancy wrapper) + resolveTenantWorkspace.
 *
 * Proves the guard ladder (401 → 404 → 403), the tenant-scoped family audience, public-audience tenant
 * resolution, the Next 15/16 Promise-params handling, and that entitlements come from the resolved tenant row
 * (zero `getTenantTier` round-trips). The sibling `vertical-slice.test.ts` pins legacy `withRoute` behavior —
 * together they guarantee the two wrappers share the pipeline without drifting.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { withSlugRoute, resolveTenantWorkspace, jsonOk, defineRoles } from '@deverjak/tenantkit-kernel'
import { createTestRuntime, type TestRuntime } from '../createTestRuntime'

// Declare the sample role vocabulary this suite exercises (minRole gates read the rank ladder).
beforeEach(() => {
  defineRoles([
    { key: 'staff', rank: 1 },
    { key: 'coach', rank: 2 },
    { key: 'admin', rank: 3, isAdmin: true },
    { key: 'owner', rank: 4, isOwner: true, isAdmin: true },
  ])
})

/** The trailing route args Next passes a handler: (Request, { params }). `params` may be a Promise or plain. */
type RouteArgs = [Request, { params: unknown }]

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

/** Two tenants, staff on A, admin on A, admin on B, a guardian linked in BOTH tenants, one linked only in B. */
function seededRuntime(): TestRuntime {
  return createTestRuntime({
    authUsers: [
      { id: 'staff-a', email: 'staff@aqua.cz', emailVerified: true },
      { id: 'admin-a', email: 'admin@aqua.cz', emailVerified: true },
      { id: 'member-b', email: 'admin@bori.cz', emailVerified: true },
      { id: 'guardian-both', email: 'rodic@obou.cz', emailVerified: true },
      { id: 'guardian-b', email: 'rodic@bori.cz', emailVerified: true },
    ],
    tenants: [
      { id: 'tenant-a', name: 'Aqua Studio', slug: 'aqua', tier: 'pro' },
      { id: 'tenant-b', name: 'Bori Gym', slug: 'bori', tier: 'free' },
    ],
    memberships: [
      { userId: 'staff-a', tenantId: 'tenant-a', role: 'staff' },
      { userId: 'admin-a', tenantId: 'tenant-a', role: 'admin' },
      { userId: 'member-b', tenantId: 'tenant-b', role: 'admin' },
    ],
    participantAccounts: [
      { userId: 'guardian-both', participantId: 'kid-a', tenantId: 'tenant-a', relation: 'guardian' },
      { userId: 'guardian-both', participantId: 'kid-b', tenantId: 'tenant-b', relation: 'guardian' },
      { userId: 'guardian-b', participantId: 'kid-b2', tenantId: 'tenant-b', relation: 'parent' },
    ],
  })
}

describe('withSlugRoute — guard ladder (401 → 404 → 403)', () => {
  it('404 NOT_FOUND for an unknown slug (authed staff)', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime }, async () => jsonOk({}))
    const res = await route(t.requestAs('staff-a'), params({ slug: 'no-such-studio' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('NOT_FOUND')
  })

  it('401 UNAUTHORIZED before the slug lookup — an anonymous probe learns nothing about slugs', async () => {
    const t = seededRuntime()
    let handlerRan = false
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime }, async () => {
      handlerRan = true
      return jsonOk({})
    })
    // Unknown slug on purpose: if 404 came first, this would leak slug (non-)existence to anonymous callers.
    const res = await route(t.anonRequest(), params({ slug: 'no-such-studio' }))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
    expect(handlerRan).toBe(false)
  })

  it('403 NOT_A_MEMBER for a signed-in user who belongs to a different tenant', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime }, async () => jsonOk({}))
    const res = await route(t.requestAs('member-b'), params({ slug: 'aqua' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('NOT_A_MEMBER')
  })

  it('minRole gates: staff below admin → 403 FORBIDDEN; admin passes → 200', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>(
      { runtime: t.runtime, minRole: 'admin' },
      async (ctx) => jsonOk({ role: ctx.role }),
    )
    const denied = await route(t.requestAs('staff-a'), params({ slug: 'aqua' }))
    expect(denied.status).toBe(403)
    expect((await denied.json()).code).toBe('FORBIDDEN')

    const allowed = await route(t.requestAs('admin-a'), params({ slug: 'aqua' }))
    expect(allowed.status).toBe(200)
    expect((await allowed.json()).role).toBe('admin')
  })

  it('ignores any ambient active-tenant cookie — the path IS the selector', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime }, async (ctx) => jsonOk({ id: ctx.tenant.id }))
    // A stale/hostile cookie pointing at tenant B must not shift the resolution off the URL's tenant A.
    const res = await route(
      t.requestAs('staff-a', { headers: { cookie: 'active_tenant_id=tenant-b' } }),
      params({ slug: 'aqua' }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('tenant-a')
  })
})

describe('withSlugRoute — family audience is tenant-scoped', () => {
  const portal = (t: TestRuntime) =>
    withSlugRoute<RouteArgs>({ runtime: t.runtime, audience: 'family' }, async (ctx) =>
      jsonOk({ ids: ctx.participant!.participantIds, canKidA: ctx.participant!.canActFor('kid-a') }),
    )

  it('403 NOT_A_PARTICIPANT when the account has links only in ANOTHER tenant', async () => {
    const t = seededRuntime()
    const res = await portal(t)(t.requestAs('guardian-b'), params({ slug: 'aqua' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('NOT_A_PARTICIPANT')
  })

  it('a guardian linked in both tenants sees ONLY the resolved tenant’s participants', async () => {
    const t = seededRuntime()
    const inAqua = await (await portal(t)(t.requestAs('guardian-both'), params({ slug: 'aqua' }))).json()
    expect(inAqua.ids).toEqual(['kid-a'])
    expect(inAqua.canKidA).toBe(true)

    const inBori = await (await portal(t)(t.requestAs('guardian-both'), params({ slug: 'bori' }))).json()
    expect(inBori.ids).toEqual(['kid-b'])
    expect(inBori.canKidA).toBe(false) // kid-a is an aqua participant — invisible through bori's portal
  })
})

describe('withSlugRoute — public audience', () => {
  it('resolves the tenant with no identity at all (a public form is still a tenant’s form)', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime, audience: 'public' }, async (ctx) =>
      jsonOk({ tenant: ctx.tenant, claims: ctx.claims }),
    )
    const res = await route(t.anonRequest(), params({ slug: 'aqua' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tenant).toEqual({ id: 'tenant-a', slug: 'aqua', name: 'Aqua Studio', tier: 'pro' })
    expect(body.claims).toBeNull()
  })

  it('404s an unknown slug for anonymous callers (no auth wall on public routes)', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime, audience: 'public' }, async () => jsonOk({}))
    const res = await route(t.anonRequest(), params({ slug: 'no-such-studio' }))
    expect(res.status).toBe(404)
  })
})

describe('withSlugRoute — params extraction', () => {
  it('accepts both Promise params (Next 15/16) and plain-object params (tests, older Next)', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime, audience: 'public' }, async (ctx) =>
      jsonOk({ slug: ctx.tenant.slug }),
    )
    const viaPromise = await route(t.anonRequest(), params({ slug: 'aqua' }))
    expect(viaPromise.status).toBe(200)

    const viaPlain = await route(t.anonRequest(), { params: { slug: 'aqua' } })
    expect(viaPlain.status).toBe(200)
    expect((await viaPlain.json()).slug).toBe('aqua')
  })

  it('honors slugParam for apps whose segment isn’t [slug]', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>(
      { runtime: t.runtime, audience: 'public', slugParam: 'project' },
      async (ctx) => jsonOk({ id: ctx.tenant.id }),
    )
    const res = await route(t.anonRequest(), params({ project: 'bori' }))
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('tenant-b')
  })

  it('a missing param key is a programming error → 500 INTERNAL, never a 404', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>(
      { runtime: t.runtime, audience: 'public', slugParam: 'project' },
      async () => jsonOk({}),
    )
    const res = await route(t.anonRequest(), params({ slug: 'aqua' })) // wrong key on purpose
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('INTERNAL')
  })
})

describe('withSlugRoute — ctx invariants', () => {
  it('builds entitlements from the resolved tenant row — ZERO getTenantTier round-trips', async () => {
    const t = seededRuntime()
    let tierCalls = 0
    const originalGetTier = t.runtime.authz.getTenantTier.bind(t.runtime.authz)
    t.runtime.authz.getTenantTier = async (tenantId: string) => {
      tierCalls++
      return originalGetTier(tenantId)
    }
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime }, async (ctx) =>
      jsonOk({ tier: ctx.entitlements!.tier }),
    )
    const res = await route(t.requestAs('admin-a'), params({ slug: 'aqua' }))
    expect(res.status).toBe(200)
    expect((await res.json()).tier).toBe('pro') // from the seeded tenant row, not a second read
    expect(tierCalls).toBe(0)
  })

  it('keeps ctx.tenantId in sync with ctx.tenant.id (compat with tenantId-keyed code)', async () => {
    const t = seededRuntime()
    const route = withSlugRoute<RouteArgs>({ runtime: t.runtime }, async (ctx) =>
      jsonOk({ same: ctx.tenantId === ctx.tenant.id, id: ctx.tenantId }),
    )
    const body = await (await route(t.requestAs('staff-a'), params({ slug: 'aqua' }))).json()
    expect(body.same).toBe(true)
    expect(body.id).toBe('tenant-a')
  })
})

describe('resolveTenantWorkspace — the page-layer companion', () => {
  it('walks the same ladder: unauthenticated → not_found → not_a_member → forbidden → ok', async () => {
    const t = seededRuntime()

    expect(await resolveTenantWorkspace(t.runtime, 'aqua', { req: t.anonRequest() }))
      .toEqual({ ok: false, reason: 'unauthenticated' })

    expect(await resolveTenantWorkspace(t.runtime, 'no-such-studio', { req: t.requestAs('admin-a') }))
      .toEqual({ ok: false, reason: 'not_found' })

    expect(await resolveTenantWorkspace(t.runtime, 'aqua', { req: t.requestAs('member-b') }))
      .toEqual({ ok: false, reason: 'not_a_member' })

    expect(await resolveTenantWorkspace(t.runtime, 'aqua', { req: t.requestAs('staff-a'), minRole: 'admin' }))
      .toEqual({ ok: false, reason: 'forbidden' })

    const ok = await resolveTenantWorkspace(t.runtime, 'aqua', { req: t.requestAs('admin-a'), minRole: 'admin' })
    expect(ok).toEqual({
      ok: true,
      workspace: {
        user: { id: 'admin-a', email: 'admin@aqua.cz' },
        tenant: { id: 'tenant-a', slug: 'aqua', name: 'Aqua Studio', tier: 'pro' },
        role: 'admin',
      },
    })
  })

  it('minRole is optional — any member resolves their workspace with their role', async () => {
    const t = seededRuntime()
    const r = await resolveTenantWorkspace(t.runtime, 'aqua', { req: t.requestAs('staff-a') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.workspace.role).toBe('staff')
  })
})
