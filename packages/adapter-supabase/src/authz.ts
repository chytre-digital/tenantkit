/**
 * `AuthzStore` port → Supabase. The few cross-cutting reads the kernel does itself (profile, memberships,
 * participant accounts, plugin activation, tier, provisioning). Backed by the SERVICE-role client and keyed by the
 * already-verified `userId` — reading a user's OWN rows by id is safe regardless of RLS, and sidesteps any
 * membership-policy recursion. Domain queries (courses, sessions, credits) are NOT here — apps run those on
 * the request-scoped `Database.user()` client so RLS applies.
 *
 * NOTE: core/public tables live in the `core`/`public` schemas. `core` must be added to Supabase's
 * "Exposed schemas" (Project → API) for `.schema('core')` to work — or wrap these in RPCs.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthzStore, ProfileRow, TenantSummary } from '@deverjak/tenantkit-kernel'
import { adminClient } from './clients'

export class SupabaseAuthzStore implements AuthzStore {
  // Client factory is injectable for tests; defaults to the lazy service-role singleton (resolved on FIRST USE,
  // not at construction — so an anon-only app (public catalogue, family sign-in) can build a runtime without the
  // SUPABASE_SERVICE_ROLE_KEY). Mirrors the pattern in storage.ts.
  constructor(private readonly client: () => SupabaseClient = adminClient) {}

  private get db(): SupabaseClient {
    return this.client()
  }

  async ensureProfile(userId: string, email: string | null): Promise<ProfileRow> {
    const { data, error } = await this.db.schema('core').from('profiles')
      .select('full_name, locale, avatar_url, phone').eq('id', userId).maybeSingle()
    if (error) throw error
    if (data) {
      return { fullName: data.full_name, locale: data.locale, avatarUrl: data.avatar_url, phone: data.phone }
    }
    const fullName = email ? (email.split('@')[0] ?? null) : null
    const { error: upsertError } = await this.db.schema('core').from('profiles')
      .upsert({ id: userId, full_name: fullName }, { onConflict: 'id', ignoreDuplicates: true })
    if (upsertError) throw upsertError
    return { fullName, locale: null, avatarUrl: null, phone: null }
  }

  async getMemberships(userId: string): Promise<Array<{ tenantId: string; role: string }>> {
    const { data, error } = await this.db.schema('core').from('memberships').select('tenant_id, role').eq('user_id', userId)
    // Fail-closed: `error != null` must always propagate — only a successful query with `data: []` means "no memberships".
    if (error) throw error
    return (data ?? []).map((m) => ({ tenantId: m.tenant_id, role: m.role }))
  }

  async getMembershipsWithTenants(userId: string): Promise<Array<{ tenant: TenantSummary; role: string }>> {
    // Two service-role reads keyed by the already-verified userId (a user's OWN membership rows are safe to
    // read regardless of RLS). Reading tenants by id list — not a PostgREST embed — keeps it robust to schema
    // exposure quirks and mirrors the loaders this replaces in the consuming apps.
    const { data: memberships, error: membershipsError } = await this.db.schema('core').from('memberships')
      .select('tenant_id, role').eq('user_id', userId)
    // Surface transport/config errors (missing grant, unexposed schema) — must NOT masquerade as an empty list.
    if (membershipsError) throw membershipsError
    if (!memberships || memberships.length === 0) return []
    const ids = memberships.map((m) => m.tenant_id)
    const { data: tenants, error } = await this.db.schema('core').from('tenants')
      .select('id, slug, name, tier').in('id', ids)
    if (error) throw error
    const roleByTenant = new Map(memberships.map((m) => [m.tenant_id, m.role]))
    // Role is the app's own vocabulary — never fabricate one. Every tenant here came from a membership row, so a
    // missing entry means an orphan tenant row; skip it rather than invent a role.
    return (tenants ?? [])
      .map((t) => {
        const role = roleByTenant.get(t.id)
        return role == null
          ? null
          : { tenant: { id: t.id, slug: t.slug, name: t.name, tier: t.tier ?? 'free' }, role }
      })
      .filter((row): row is { tenant: TenantSummary; role: string } => row !== null)
  }

  async getParticipantAccounts(userId: string): Promise<Array<{ participantId: string; tenantId: string; relation: string }>> {
    const { data, error } = await this.db.schema('core').from('participant_accounts')
      .select('participant_id, tenant_id, relation').eq('user_id', userId)
    if (error) throw error
    return (data ?? []).map((p) => ({ participantId: p.participant_id, tenantId: p.tenant_id, relation: p.relation }))
  }

  async getPluginActivation(tenantId: string, pluginId: string): Promise<{ enabled: boolean } | null> {
    const { data, error } = await this.db.schema('core').from('plugin_activations')
      .select('is_enabled').eq('tenant_id', tenantId).eq('plugin_id', pluginId).maybeSingle()
    if (error) throw error
    return data ? { enabled: data.is_enabled } : null
  }

  async getTenantTier(tenantId: string): Promise<string> {
    const { data, error } = await this.db.schema('core').from('tenants').select('tier').eq('id', tenantId).single()
    if (error) throw error
    return data?.tier ?? 'free'
  }

  async getTenantBySlug(slug: string): Promise<TenantSummary | null> {
    const { data, error } = await this.db.schema('core').from('tenants')
      .select('id, slug, name, tier').eq('slug', slug).maybeSingle()
    // Surface transport/config errors (missing grant, unexposed schema) — they must NOT masquerade as 404.
    if (error) throw error
    return data ? { id: data.id, slug: data.slug, name: data.name, tier: data.tier ?? 'free' } : null
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
