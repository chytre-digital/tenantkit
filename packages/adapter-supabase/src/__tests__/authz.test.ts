/**
 * Unit tests for `SupabaseAuthzStore`'s fail-closed error contract (incident: tenantkit-supabase-membership-
 * query-error-masked). A fake Supabase client is injected — same pattern as storage.test.ts — so we can return
 * `{ data: null, error }` from individual PostgREST calls and assert it is never treated as a legitimate empty
 * result. The in-memory conformance store can't reproduce this: it has no notion of a transport/config error, so
 * these tests target the adapter directly.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseAuthzStore } from '../authz'

type Result = { data: unknown; error: unknown }

const PG_ERROR = { code: 'PGRST106', message: 'The schema must be one of the following: public', details: null, hint: null }
const USER_ID = 'user-1'
const TENANT_ID = 'tenant-1'

/** A chainable, awaitable fake query builder: `.select().eq()` resolves directly, `.maybeSingle()`/`.single()`/`.upsert()` too. */
function chain(result: Result) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    upsert: async () => result,
    then: (resolve: (v: Result) => void, reject?: (e: unknown) => void) => Promise.resolve(result).then(resolve, reject),
  }
  return builder
}

/** `byTable` holds a per-table queue of responses, consumed in call order — so a table hit twice (e.g. `profiles`
 * read-then-upsert) can return a different result each time. */
function makeClient(byTable: Record<string, Result[]>) {
  const client = {
    schema: () => ({
      from: (table: string) => {
        const queue = byTable[table]
        const result = queue?.shift()
        if (!result) throw new Error(`no fixture left for table "${table}"`)
        return chain(result)
      },
    }),
  }
  return new SupabaseAuthzStore(() => client as unknown as SupabaseClient)
}

describe('getMembershipsWithTenants', () => {
  it('propagates an error from the first (memberships) query instead of returning []', async () => {
    const store = makeClient({ memberships: [{ data: null, error: PG_ERROR }] })
    await expect(store.getMembershipsWithTenants(USER_ID)).rejects.toMatchObject({ code: 'PGRST106' })
  })

  it('returns [] only for a genuinely empty, error-free membership result', async () => {
    const store = makeClient({ memberships: [{ data: [], error: null }] })
    await expect(store.getMembershipsWithTenants(USER_ID)).resolves.toEqual([])
  })

  it('propagates an error from the second (tenants) query', async () => {
    const store = makeClient({
      memberships: [{ data: [{ tenant_id: TENANT_ID, role: 'owner' }], error: null }],
      tenants: [{ data: null, error: PG_ERROR }],
    })
    await expect(store.getMembershipsWithTenants(USER_ID)).rejects.toMatchObject({ code: 'PGRST106' })
  })

  it('maps memberships onto tenants on success', async () => {
    const store = makeClient({
      memberships: [{ data: [{ tenant_id: TENANT_ID, role: 'owner' }], error: null }],
      tenants: [{ data: [{ id: TENANT_ID, slug: 'acme', name: 'Acme', tier: 'pro' }], error: null }],
    })
    await expect(store.getMembershipsWithTenants(USER_ID)).resolves.toEqual([
      { tenant: { id: TENANT_ID, slug: 'acme', name: 'Acme', tier: 'pro' }, role: 'owner' },
    ])
  })
})

describe('getMemberships', () => {
  it('propagates a query error instead of returning []', async () => {
    const store = makeClient({ memberships: [{ data: null, error: PG_ERROR }] })
    await expect(store.getMemberships(USER_ID)).rejects.toMatchObject({ code: 'PGRST106' })
  })

  it('returns [] for a genuinely empty, error-free result', async () => {
    const store = makeClient({ memberships: [{ data: [], error: null }] })
    await expect(store.getMemberships(USER_ID)).resolves.toEqual([])
  })
})

describe('ensureProfile', () => {
  it('propagates a read error instead of treating it as "no profile yet"', async () => {
    const store = makeClient({ profiles: [{ data: null, error: PG_ERROR }] })
    await expect(store.ensureProfile(USER_ID, 'a@b.com')).rejects.toMatchObject({ code: 'PGRST106' })
  })

  it('propagates an upsert error when creating a new profile', async () => {
    const store = makeClient({ profiles: [{ data: null, error: null }, { data: null, error: PG_ERROR }] })
    await expect(store.ensureProfile(USER_ID, 'a@b.com')).rejects.toMatchObject({ code: 'PGRST106' })
  })
})

describe('getParticipantAccounts', () => {
  it('propagates a query error instead of returning []', async () => {
    const store = makeClient({ participant_accounts: [{ data: null, error: PG_ERROR }] })
    await expect(store.getParticipantAccounts(USER_ID)).rejects.toMatchObject({ code: 'PGRST106' })
  })
})

describe('getPluginActivation', () => {
  it('propagates a query error instead of returning null (disabled)', async () => {
    const store = makeClient({ plugin_activations: [{ data: null, error: PG_ERROR }] })
    await expect(store.getPluginActivation(TENANT_ID, 'sms')).rejects.toMatchObject({ code: 'PGRST106' })
  })
})

describe('getTenantTier', () => {
  it('propagates a query error instead of defaulting to "free"', async () => {
    const store = makeClient({ tenants: [{ data: null, error: PG_ERROR }] })
    await expect(store.getTenantTier(TENANT_ID)).rejects.toMatchObject({ code: 'PGRST106' })
  })
})
