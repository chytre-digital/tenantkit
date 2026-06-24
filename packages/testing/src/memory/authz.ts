/**
 * Realizes docs/14-portability-and-providers.md §7 (in-memory adapter) — the `AuthzStore` port
 * (ports/index.ts §2) over the shared `MemoryStore`'s seeded `core.*` tables.
 *
 * These are the handful of cross-cutting reads the kernel does itself (doc 14 §4.1) — profile bootstrap,
 * memberships, guardianships, plugin activation, tier, `provisionTenant`. The Supabase adapter backs these with
 * service-role reads keyed by the verified `userId`; here they're plain scans over the seeded arrays. Keeping
 * the SAME store the `Database` filters means a membership seeded for RLS is the SAME row `getMemberships`
 * returns — no drift between "what authz sees" and "what RLS enforces".
 */
import type { AuthzStore, ProfileRow } from '@tenantkit/kernel'
import type { MemoryStore, ProfileRecord } from './store'

export class MemoryAuthzStore implements AuthzStore {
  constructor(private readonly store: MemoryStore) {}

  async ensureProfile(userId: string, email: string | null): Promise<ProfileRow> {
    const existing = this.store.profiles.find((p) => p.id === userId)
    if (existing) return toProfileRow(existing)
    // Idempotent bootstrap: derive a name from the local-part, matching the kernel's requireClaims behavior.
    const fullName = email ? (email.split('@')[0] ?? null) : null
    const created: ProfileRecord = { id: userId, fullName, locale: null, avatarUrl: null, phone: null }
    this.store.profiles.push(created)
    return toProfileRow(created)
  }

  async getMemberships(userId: string): Promise<Array<{ tenantId: string; role: string }>> {
    return this.store.memberships
      .filter((m) => m.userId === userId)
      .map((m) => ({ tenantId: m.tenantId, role: m.role }))
  }

  async getGuardianships(
    userId: string,
  ): Promise<Array<{ participantId: string; tenantId: string; relation: string }>> {
    return this.store.guardianships
      .filter((g) => g.userId === userId)
      .map((g) => ({ participantId: g.participantId, tenantId: g.tenantId, relation: g.relation }))
  }

  async getPluginActivation(tenantId: string, pluginId: string): Promise<{ enabled: boolean } | null> {
    const row = this.store.pluginActivations.find(
      (a) => a.tenantId === tenantId && a.pluginId === pluginId,
    )
    return row ? { enabled: row.enabled } : null
  }

  async getTenantTier(tenantId: string): Promise<string> {
    return this.store.tenants.find((t) => t.id === tenantId)?.tier ?? 'free'
  }

  async provisionTenant(input: { name: string; slug: string; ownerId: string }): Promise<{ tenantId: string }> {
    // Route through the same fake RPC the Database exposes (create_tenant_with_owner), so both paths agree.
    const tenantId = this.store.rpcs.get('create_tenant_with_owner')?.(
      { p_name: input.name, p_slug: input.slug, p_owner: input.ownerId },
      this.store,
      { role: 'service', userId: null },
    ) as string
    return { tenantId }
  }
}

export function createMemoryAuthzStore(store: MemoryStore): MemoryAuthzStore {
  return new MemoryAuthzStore(store)
}

function toProfileRow(p: ProfileRecord): ProfileRow {
  return { fullName: p.fullName, locale: p.locale, avatarUrl: p.avatarUrl, phone: p.phone }
}
