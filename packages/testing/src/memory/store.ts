/**
 * Realizes docs/14-portability-and-providers.md §7 (in-memory adapter) + §3.1 (the `current_user_id()` seam).
 *
 * The shared, Map-backed substrate every in-memory port reads/writes. It is ONE store so the three ports stay
 * consistent: the `Database` simulates RLS by filtering these same `core.*` tables that `AuthzStore` reads and
 * `IdentityProvider` provisions into. The tables mirror docs/03-data-model.md §3 (`core.profiles`,
 * `core.memberships`, `core.participant_accounts`, `core.tenants`, `core.plugin_activations`) plus an `authUsers`
 * table standing in for GoTrue's user store.
 *
 * "Simulated RLS" here is the same logic docs/14 §3.1 promises the in-memory adapter runs: the store tracks a
 * CURRENT ACTOR (the resolved `core.current_user_id()`), and the predicate helpers below evaluate
 * `is_member_of` / `can_act_for_participant` against the membership/participant-account rows — exactly the
 * SECURITY DEFINER functions from db/index.ts, in TypeScript. Tenant-scoped reads through the `user` handle are
 * filtered by these predicates; the `service` handle bypasses them (mirroring the service-role RLS bypass).
 */

/** A GoTrue-equivalent user row (the IdentityProvider's table). Passwords are stored in clear — TESTS ONLY. */
export interface AuthUserRow {
  id: string
  email: string
  emailVerified: boolean
  /** Cleartext — acceptable strictly because this store only ever lives in a test process. */
  password?: string
}

export interface ProfileRecord {
  id: string
  fullName: string | null
  locale: string | null
  avatarUrl: string | null
  phone: string | null
}

export interface MembershipRecord {
  userId: string
  tenantId: string
  role: string
}

/** A participant-account link row — a user who may act for a participant. `relation` is 'self' or an app value. */
export interface ParticipantAccountRecord {
  userId: string
  participantId: string
  tenantId: string
  relation: string
}

export interface TenantRecord {
  id: string
  name: string
  slug: string
  tier: string
}

export interface PluginActivationRecord {
  tenantId: string
  pluginId: string
  enabled: boolean
}

/**
 * The seed an app hands to `createTestRuntime(seed)`. Everything is optional; omitted tables start empty.
 * `genericRows` lets a test pre-load arbitrary domain tables (e.g. `courses`) so `query()`/`rpc()` have data.
 */
export interface MemorySeed {
  authUsers?: AuthUserRow[]
  profiles?: ProfileRecord[]
  memberships?: MembershipRecord[]
  participantAccounts?: ParticipantAccountRecord[]
  tenants?: TenantRecord[]
  pluginActivations?: PluginActivationRecord[]
  /** Arbitrary extra tables, keyed by table name → rows (each row MUST carry `tenant_id` for RLS to apply). */
  genericRows?: Record<string, Array<Record<string, unknown>>>
}

/**
 * Who the current statement runs AS — the in-memory analogue of the resolved `core.current_user_id()` plus the
 * Postgres role. `service` bypasses RLS; `anon` has no identity; `user` carries the actor id.
 */
export type Actor =
  | { role: 'service'; userId: null }
  | { role: 'anon'; userId: null }
  | { role: 'user'; userId: string }

/** A registered fake RPC: `(args, store, actor) => result`. Mirrors a SECURITY DEFINER function's signature. */
export type FakeRpc = (args: Record<string, unknown>, store: MemoryStore, actor: Actor) => unknown

/**
 * The Map-backed store. Tables are plain arrays of records (small N — it's a test). Genuine relational indexing
 * is unnecessary; linear scans keep the simulation obvious and debuggable.
 */
export class MemoryStore {
  authUsers: AuthUserRow[]
  profiles: ProfileRecord[]
  memberships: MembershipRecord[]
  participantAccounts: ParticipantAccountRecord[]
  tenants: TenantRecord[]
  pluginActivations: PluginActivationRecord[]
  /** Arbitrary domain tables, name → rows. */
  generic: Map<string, Array<Record<string, unknown>>>
  /** Registered fake RPCs, name → handler. */
  rpcs: Map<string, FakeRpc>

  constructor(seed: MemorySeed = {}) {
    this.authUsers = [...(seed.authUsers ?? [])]
    this.profiles = [...(seed.profiles ?? [])]
    this.memberships = [...(seed.memberships ?? [])]
    this.participantAccounts = [...(seed.participantAccounts ?? [])]
    this.tenants = [...(seed.tenants ?? [])]
    this.pluginActivations = [...(seed.pluginActivations ?? [])]
    this.generic = new Map(
      Object.entries(seed.genericRows ?? {}).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
    )
    this.rpcs = new Map()
    registerDefaultRpcs(this)
  }

  /** Register (or override) a fake RPC. Returns `this` for chaining at seed time. */
  registerRpc(name: string, fn: FakeRpc): this {
    this.rpcs.set(name, fn)
    return this
  }

  /** Get a domain table by name, creating it empty on first access. */
  table(name: string): Array<Record<string, unknown>> {
    let rows = this.generic.get(name)
    if (!rows) {
      rows = []
      this.generic.set(name, rows)
    }
    return rows
  }

  // ── Simulated RLS predicates — the TS twins of core.is_member_of / core.can_act_for_participant (db/index.ts) ──

  /** `core.role_rank()` — MUST match rbac/roles.ts + ROLE_RANK_SQL (db/index.ts). */
  roleRank(role: string): number {
    switch (role) {
      case 'owner':
        return 4
      case 'admin':
        return 3
      case 'coach':
        return 2
      case 'staff':
        return 1
      default:
        return 0
    }
  }

  /** `core.is_member_of(tenant, minRole)` evaluated against the membership rows for `userId`. */
  isMemberOf(userId: string | null, tenantId: string, minRole = 'staff'): boolean {
    if (!userId) return false
    return this.memberships.some(
      (m) =>
        m.userId === userId && m.tenantId === tenantId && this.roleRank(m.role) >= this.roleRank(minRole),
    )
  }

  /** `core.can_act_for_participant(participant)` — may this user act for that participant? */
  canActForParticipant(userId: string | null, participantId: string): boolean {
    if (!userId) return false
    return this.participantAccounts.some((p) => p.userId === userId && p.participantId === participantId)
  }

  /** The set of tenant ids the actor can see at all (any membership or participant account). Drives row filtering. */
  visibleTenantIds(actor: Actor): Set<string> {
    if (actor.role === 'service') return new Set(this.tenants.map((t) => t.id)) // bypass
    if (actor.role === 'anon' || actor.userId === null) return new Set()
    const ids = new Set<string>()
    for (const m of this.memberships) if (m.userId === actor.userId) ids.add(m.tenantId)
    for (const p of this.participantAccounts) if (p.userId === actor.userId) ids.add(p.tenantId)
    return ids
  }
}

/**
 * The built-in RPCs every store ships with — the kernel's own SECURITY DEFINER functions, re-expressed.
 * Apps register their domain RPCs (e.g. `redeem_credit_into_session`) on top via `store.registerRpc()`.
 */
function registerDefaultRpcs(store: MemoryStore): void {
  // core.create_tenant_with_owner(p_name, p_slug, p_owner) → uuid  (CREATE_TENANT_WITH_OWNER_SQL, db/index.ts)
  store.registerRpc('create_tenant_with_owner', (args) => {
    const id = `tenant-${store.tenants.length + 1}`
    const name = String(args['p_name'] ?? '')
    const slug = String(args['p_slug'] ?? '')
    const owner = String(args['p_owner'] ?? '')
    store.tenants.push({ id, name, slug, tier: 'free' })
    store.memberships.push({ userId: owner, tenantId: id, role: 'owner' })
    return id
  })
}
