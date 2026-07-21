/**
 * Runs the FULL port conformance suite (conformance.ts) against the in-memory runtime — proving the kernel's
 * contract holds with zero vendor present. The Supabase adapter ships the same `runAllConformance(makeHarness)`
 * call wired to a throwaway project in an integration lane; a community adapter is "done" when this goes green.
 */
import { describe } from 'vitest'
import { defineRoles } from '@deverjak/tenantkit-kernel'
import { createTestRuntime } from '../createTestRuntime'
import { type ConformanceHarness, runAllConformance } from '../conformance'

function makeHarness(): ConformanceHarness {
  // Declare a sample role vocabulary (the in-memory analogue of seeding core.roles) — what an adapter must do.
  defineRoles([
    { key: 'staff', rank: 1 },
    { key: 'coach', rank: 2 },
    { key: 'admin', rank: 3, isAdmin: true },
    { key: 'owner', rank: 4, isOwner: true, isAdmin: true },
  ])
  const t = createTestRuntime()

  // An RLS-aware domain RPC so the scoping suite has something to count (mirrors a real SECURITY DEFINER fn).
  t.store.registerRpc('count_courses', (args, store, actor) => {
    const tid = String(args['tenant_id'] ?? '')
    if (actor.role !== 'service' && !store.isMemberOf(actor.userId, tid)) return { count: 0 } // RLS
    return { count: store.table('courses').filter((r) => r['tenant_id'] === tid).length }
  })

  let n = 0
  return {
    runtime: t.runtime,
    anonRequest: () => t.anonRequest(),
    requestAs: (userId) => t.requestAs(userId),
    async seedUserWithMembership({ email, role = 'staff', tenantSlug }) {
      const userId = `user-${++n}`
      const tenantId = tenantSlug ? `tenant-${tenantSlug}` : `tenant-${n}`
      t.store.authUsers.push({ id: userId, email, emailVerified: true })
      if (!t.store.tenants.some((x) => x.id === tenantId)) {
        t.store.tenants.push({ id: tenantId, name: tenantId, slug: tenantSlug ?? tenantId, tier: 'free' })
        t.store.table('courses').push({ id: `course-${tenantId}`, tenant_id: tenantId }) // one row to count
      }
      t.store.memberships.push({ userId, tenantId, role })
      return { userId, tenantId }
    },
  }
}

describe('in-memory runtime — full port conformance', () => {
  runAllConformance(makeHarness)
})
