/**
 * `AuthzStore` port → Supabase. The few cross-cutting reads the kernel does itself (profile, memberships,
 * guardianships, plugin activation, tier, provisioning). Backed by the SERVICE-role client and keyed by the
 * already-verified `userId` — reading a user's OWN rows by id is safe regardless of RLS, and sidesteps any
 * membership-policy recursion. Domain queries (courses, sessions, credits) are NOT here — apps run those on
 * the request-scoped `Database.user()` client so RLS applies.
 *
 * NOTE: core/public tables live in the `core`/`public` schemas. `core` must be added to Supabase's
 * "Exposed schemas" (Project → API) for `.schema('core')` to work — or wrap these in RPCs.
 */
import type { AuthzStore, ProfileRow } from '@tenantkit/kernel'
import { adminClient } from './clients'

export class SupabaseAuthzStore implements AuthzStore {
  private db = adminClient()

  async ensureProfile(userId: string, email: string | null): Promise<ProfileRow> {
    const { data } = await this.db.schema('core').from('profiles')
      .select('full_name, locale, avatar_url, phone').eq('id', userId).maybeSingle()
    if (data) {
      return { fullName: data.full_name, locale: data.locale, avatarUrl: data.avatar_url, phone: data.phone }
    }
    const fullName = email ? (email.split('@')[0] ?? null) : null
    await this.db.schema('core').from('profiles').upsert({ id: userId, full_name: fullName }, { onConflict: 'id', ignoreDuplicates: true })
    return { fullName, locale: null, avatarUrl: null, phone: null }
  }

  async getMemberships(userId: string): Promise<Array<{ tenantId: string; role: string }>> {
    const { data } = await this.db.schema('core').from('memberships').select('tenant_id, role').eq('user_id', userId)
    return (data ?? []).map((m) => ({ tenantId: m.tenant_id, role: m.role }))
  }

  async getGuardianships(userId: string): Promise<Array<{ participantId: string; tenantId: string; relation: string }>> {
    const { data } = await this.db.schema('core').from('guardianships')
      .select('participant_id, tenant_id, relation').eq('user_id', userId)
    return (data ?? []).map((g) => ({ participantId: g.participant_id, tenantId: g.tenant_id, relation: g.relation }))
  }

  async getPluginActivation(tenantId: string, pluginId: string): Promise<{ enabled: boolean } | null> {
    const { data } = await this.db.schema('core').from('plugin_activations')
      .select('is_enabled').eq('tenant_id', tenantId).eq('plugin_id', pluginId).maybeSingle()
    return data ? { enabled: data.is_enabled } : null
  }

  async getTenantTier(tenantId: string): Promise<string> {
    const { data } = await this.db.schema('core').from('tenants').select('tier').eq('id', tenantId).single()
    return data?.tier ?? 'free'
  }

  async provisionTenant(input: { name: string; slug: string; ownerId: string }): Promise<{ tenantId: string }> {
    const { data, error } = await this.db.schema('core').rpc('create_tenant_with_owner', {
      p_name: input.name, p_slug: input.slug, p_owner: input.ownerId,
    })
    if (error) throw error
    return { tenantId: data as string }
  }
}

export const createSupabaseAuthzStore = (): SupabaseAuthzStore => new SupabaseAuthzStore()
