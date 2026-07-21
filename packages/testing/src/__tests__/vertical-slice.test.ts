/**
 * Phase 0 EXIT CRITERION (roadmap §2): "a member can sign in, create a tenant, and CRUD a course under RLS"
 * — proven end-to-end, vendor-free, through real `withRoute` handlers against the in-memory runtime. This is
 * the single thread that exercises every core subsystem: identity → tenant resolution → role gate → the
 * RLS-scoped DB handle → response. If it holds, the framework is real.
 *
 * RLS here is the in-memory twin of `core.is_member_of()` (store.ts) — the SAME predicate the Postgres
 * SECURITY DEFINER function runs. The Supabase adapter proves the identical slice against real Postgres RLS
 * in an integration lane; this proves the contract with zero vendors.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { withRoute, jsonOk, provisionTenant, defineRoles } from '@deverjak/tenantkit-kernel'
import { createTestRuntime } from '../createTestRuntime'

// Declare the sample role vocabulary this suite exercises (rank gates + owner provisioning read it).
beforeEach(() => {
  defineRoles([
    { key: 'staff', rank: 1 },
    { key: 'coach', rank: 2 },
    { key: 'admin', rank: 3, isAdmin: true },
    { key: 'owner', rank: 4, isOwner: true, isAdmin: true },
  ])
})

describe('Phase 0 vertical slice — sign in → create tenant → create + list course, under RLS', () => {
  it('a member creates and lists their course; another tenant cannot see it', async () => {
    const t = createTestRuntime()

    // Domain RPCs the handlers call — RLS-aware, exactly like the SECURITY DEFINER functions they stand in for.
    t.store.registerRpc('create_course', (args, store, actor) => {
      const tenantId = String(args['tenant_id'])
      if (!store.isMemberOf(actor.userId, tenantId, 'admin')) throw new Error('RLS: not an admin of this tenant')
      const id = `course-${store.table('courses').length + 1}`
      store.table('courses').push({ id, tenant_id: tenantId, title: String(args['title']) })
      return { id }
    })
    t.store.registerRpc('list_courses', (args, store, actor) => {
      const tenantId = String(args['tenant_id'])
      if (!store.isMemberOf(actor.userId, tenantId)) return { courses: [] } // RLS: non-members see nothing
      return { courses: store.table('courses').filter((c) => c['tenant_id'] === tenantId) }
    })

    // ── sign in: two owners (a session-bearing request models "signed in", see createTestRuntime.requestAs) ──
    t.store.authUsers.push({ id: 'owner-1', email: 'a@studio.cz', emailVerified: true })
    t.store.authUsers.push({ id: 'owner-2', email: 'b@studio.cz', emailVerified: true })

    // ── create a tenant (create_tenant_with_owner → tenant + owner membership, atomically) ──
    const { tenantId } = await provisionTenant(t.runtime, { name: 'Delfínek', slug: 'delfinek', ownerUserId: 'owner-1' })
    await provisionTenant(t.runtime, { name: 'Jiné studio', slug: 'jine', ownerUserId: 'owner-2' })

    // ── the routes: real withRoute, staff audience. Tenant falls back to the caller's (only) membership. ──
    const createCourse = withRoute(
      { runtime: t.runtime, audience: 'staff', minRole: 'admin' },
      async (ctx, _req: Request) =>
        jsonOk({ course: await ctx.db.user().rpc('create_course', { tenant_id: ctx.tenantId, title: 'Plavání pro předškoláky' }) }),
    )
    const listCourses = withRoute(
      { runtime: t.runtime, audience: 'staff' },
      async (ctx, _req: Request) => jsonOk(await ctx.db.user().rpc('list_courses', { tenant_id: ctx.tenantId })),
    )

    // 1) owner-1 creates a course in their tenant → 200.
    const created = await createCourse(t.requestAs('owner-1'))
    expect(created.status).toBe(200)
    expect((await created.json()).course.id).toBe('course-1')

    // 2) owner-1 lists → sees exactly their one course.
    const mine = await (await listCourses(t.requestAs('owner-1'))).json()
    expect(mine.courses).toHaveLength(1)
    expect(mine.courses[0].title).toBe('Plavání pro předškoláky')

    // 3) RLS isolation: owner-2 (a different tenant) lists → sees nothing, even though the row exists.
    const theirs = await (await listCourses(t.requestAs('owner-2'))).json()
    expect(theirs.courses).toHaveLength(0)

    // 4) the row really is there at the service (RLS-bypass) level — isolation is RLS, not absence of data.
    expect(t.store.table('courses')).toHaveLength(1)
    expect(t.store.table('courses')[0]!['tenant_id']).toBe(tenantId)
  })

  it('an unauthenticated request is rejected (401) before reaching the handler', async () => {
    const t = createTestRuntime()
    let handlerRan = false
    const route = withRoute({ runtime: t.runtime, audience: 'staff' }, async (_ctx, _req: Request) => {
      handlerRan = true
      return jsonOk({})
    })
    const res = await route(t.anonRequest())
    expect(res.status).toBe(401)
    expect(handlerRan).toBe(false)
  })
})
