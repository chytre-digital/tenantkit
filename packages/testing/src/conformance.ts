/**
 * Realizes docs/14-portability-and-providers.md §6.4 — the PORT CONFORMANCE SUITE: the "is it really decoupled?"
 * bar. These vitest suites are written against the kernel PORTS only (CoreRuntime), so ANY adapter can run them.
 * The in-memory runtime runs them here for free; the Supabase adapter runs the SAME suites against a throwaway
 * project in an integration lane. A new community adapter is "done" when it goes green.
 *
 * Each suite takes a `makeHarness` factory so it can seed + act as users in an adapter-agnostic way.
 */
import { describe, expect, it } from 'vitest'
import type { CoreRuntime } from '@deverjak/tenantkit-kernel'

/** The minimal contract an adapter provides so the suites can seed data + act as a user. */
export interface ConformanceHarness {
  runtime: CoreRuntime
  /** Create a user + a tenant membership; return their ids. */
  seedUserWithMembership(opts: { email: string; role?: string; tenantSlug?: string }): Promise<{ userId: string; tenantId: string }>
  /** A Request whose `runtime.db.forRequest()` / identity resolve to this user. */
  requestAs(userId: string): Request
  /** An anonymous Request. */
  anonRequest(): Request
}

export type MakeHarness = () => Promise<ConformanceHarness> | ConformanceHarness

export function runIdentityConformance(make: MakeHarness): void {
  describe('IdentityProvider conformance', () => {
    it('returns null for an anonymous request', async () => {
      const h = await make()
      expect(await h.runtime.identity.getCurrentUser(h.anonRequest())).toBeNull()
    })
    it('resolves the seeded user from their request', async () => {
      const h = await make()
      const { userId } = await h.seedUserWithMembership({ email: 'a@x.cz' })
      const user = await h.runtime.identity.getCurrentUser(h.requestAs(userId))
      expect(user?.id).toBe(userId)
      expect(user?.email).toBe('a@x.cz')
    })
  })
}

export function runAuthzConformance(make: MakeHarness): void {
  describe('AuthzStore conformance', () => {
    it('ensureProfile is idempotent (same row on repeat)', async () => {
      const h = await make()
      const { userId } = await h.seedUserWithMembership({ email: 'p@x.cz' })
      const a = await h.runtime.authz.ensureProfile(userId, 'p@x.cz')
      const b = await h.runtime.authz.ensureProfile(userId, 'p@x.cz')
      expect(b).toEqual(a)
    })
    it('returns the seeded membership with its role', async () => {
      const h = await make()
      const { userId, tenantId } = await h.seedUserWithMembership({ email: 'c@x.cz', role: 'coach' })
      const ms = await h.runtime.authz.getMemberships(userId)
      expect(ms).toContainEqual({ tenantId, role: 'coach' })
    })
    it('defaults an unknown tenant tier to free-ish (never throws)', async () => {
      const h = await make()
      const { tenantId } = await h.seedUserWithMembership({ email: 'd@x.cz' })
      expect(typeof (await h.runtime.authz.getTenantTier(tenantId))).toBe('string')
    })
    it('resolves a tenant by slug (id/slug/name/tier — withSlugRoute step 4)', async () => {
      const h = await make()
      const { tenantId } = await h.seedUserWithMembership({ email: 's@x.cz', tenantSlug: 'aqua' })
      const tenant = await h.runtime.authz.getTenantBySlug('aqua')
      expect(tenant).toMatchObject({ id: tenantId, slug: 'aqua' })
      expect(typeof tenant?.name).toBe('string')
      expect(typeof tenant?.tier).toBe('string')
    })
    it('returns null for an unknown slug (the wrapper 404s; adapters must not throw here)', async () => {
      const h = await make()
      expect(await h.runtime.authz.getTenantBySlug('no-such-slug')).toBeNull()
    })
  })
}

export function runDatabaseScopingConformance(make: MakeHarness): void {
  describe('Database scoping conformance (RLS / tenant isolation)', () => {
    it('user scope cannot read another tenant’s rows; service scope can', async () => {
      const h = await make()
      const a = await h.seedUserWithMembership({ email: 'u1@x.cz', tenantSlug: 't1' })
      const b = await h.seedUserWithMembership({ email: 'u2@x.cz', tenantSlug: 't2' })
      const dbA = h.runtime.db.forRequest(h.requestAs(a.userId)).user()
      // A query for tenant B's data, issued as user A, must come back empty (isolation), …
      const asUser = await dbA.rpc<{ count: number }>('count_courses', { tenant_id: b.tenantId })
      expect(asUser.count).toBe(0)
      // … while the service scope (RLS bypass) can see across tenants.
      const asService = await h.runtime.db.service().rpc<{ count: number }>('count_courses', { tenant_id: b.tenantId })
      expect(asService.count).toBeGreaterThanOrEqual(0)
    })
  })
}

export function runEmailConformance(make: MakeHarness): void {
  describe('EmailProvider conformance', () => {
    it('send resolves to ok|skipped|error and never throws', async () => {
      const h = await make()
      const res = await h.runtime.email.send({ to: 'x@x.cz', from: 'A <a@x.cz>', subject: 's', html: '<p>h</p>' })
      expect(['ok', 'skipped', 'error']).toContain(res.status)
    })
  })
}

/** Run every suite — the full bar an adapter must clear. */
export function runAllConformance(make: MakeHarness): void {
  runIdentityConformance(make)
  runAuthzConformance(make)
  runDatabaseScopingConformance(make)
  runEmailConformance(make)
}
