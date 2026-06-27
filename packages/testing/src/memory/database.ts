/**
 * Realizes docs/14-portability-and-providers.md §7 (in-memory adapter) + §3.1 (the RLS / `current_user_id()`
 * seam) — the `Database` port (ports/index.ts §2) backed entirely by `MemoryStore`.
 *
 * This is the load-bearing honesty check. The kernel's whole isolation story is "RLS in the database means even
 * a buggy handler can't leak across tenants" (doc 14 §3). To prove the kernel is decoupled WITHOUT a Postgres,
 * this adapter SIMULATES RLS:
 *
 *   • `forRequest(req)` resolves the CURRENT ACTOR from the request — the in-memory twin of "PostgREST injects
 *     the JWT" / "`SET LOCAL app.user_id`". Since there's no real JWT, the actor id rides in a header the test
 *     runtime sets (`MEMORY_ACTOR_HEADER`); no header ⇒ anonymous.
 *   • `user()` returns a `ScopedDb` whose reads are FILTERED to the actor's tenants (via `MemoryStore`'s
 *     `is_member_of` twin) — a query can't return another tenant's rows, just like RLS.
 *   • `anon()` sees only rows a no-identity caller could (here: none of the tenant tables) — RLS still applies.
 *   • `service()` (and `Database.service()`) BYPASS the filter — the service-role bypass; callers re-check authz.
 *   • `rpc()` dispatches to fake RPCs registered on the store (kernel's `create_tenant_with_owner` ships built-in).
 *   • `query()` IS supported here (unlike the Supabase user/anon scopes): a tagged-template `select * from <t>`
 *     filtered the same way. Driver adapters implement real `query()`; this models that capability.
 *   • `tx()` runs inline (no real BEGIN/COMMIT needed in a single-process Map store), holding the actor.
 */
import type { Database, RequestDb, ScopedDb } from '@deverjak/tenantkit-kernel'
import { type Actor, MemoryStore } from './store'

/** The request header the in-memory runtime uses to carry the resolved actor id into `Database.forRequest`. */
export const MEMORY_ACTOR_HEADER = 'x-memory-actor'
/** Header value selecting the service role (bypass) for a request, used by out-of-band/webhook-style tests. */
export const MEMORY_SERVICE_ACTOR = '@service'

/**
 * A `ScopedDb` over the store, pinned to one `Actor`. Tenant-table reads are filtered by the actor's
 * visible-tenant set (simulated RLS); `service` actors see everything.
 */
export class MemoryScopedDb implements ScopedDb {
  constructor(
    private readonly store: MemoryStore,
    private readonly actor: Actor,
  ) {}

  async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const handler = this.store.rpcs.get(fn)
    if (!handler) {
      throw new Error(`[memory-db] no fake RPC registered for "${fn}" (register one via store.registerRpc)`)
    }
    return handler(args, this.store, this.actor) as T
  }

  /**
   * Minimal tagged-template SQL. Recognizes `select * from <table>` (optionally `where <col> = ${value}`),
   * then applies the same tenant filter `user()`/`anon()` would. Enough to prove driver-style `query()` works
   * over the port; it is NOT a SQL engine. Unsupported SQL throws loudly so a test never silently passes.
   */
  async query<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
    const sql = strings.join('?').trim().toLowerCase()
    const match = /^select\s+\*\s+from\s+([a-z_][a-z0-9_.]*)\s*(?:where\s+([a-z_][a-z0-9_]*)\s*=\s*\?)?\s*;?$/.exec(
      sql,
    )
    if (!match) {
      throw new Error(`[memory-db] query() only supports "select * from <table> [where <col> = \${v}]"; got: ${sql}`)
    }
    const table = stripSchema(match[1] ?? '')
    const whereCol = match[2]
    const whereVal = values[0]

    let rows = this.rowsFor(table)
    if (whereCol) rows = rows.filter((r) => r[whereCol] === whereVal)
    return rows.map((r) => ({ ...r })) as T[]
  }

  async tx<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
    // Single-process Map store: there is nothing to BEGIN/COMMIT. The actor identity holds for the callback.
    return fn(this)
  }

  /** The store rows for a table, with simulated RLS applied for this actor. */
  private rowsFor(table: string): Array<Record<string, unknown>> {
    const all = this.namedTable(table)
    if (this.actor.role === 'service') return all // service bypasses RLS
    const visible = this.store.visibleTenantIds(this.actor)
    // RLS analogue: a row is visible only if its tenant is in the actor's visible set. Rows without a
    // `tenant_id` are treated as tenant-scoped-and-hidden for non-service actors (fail closed).
    return all.filter((r) => typeof r['tenant_id'] === 'string' && visible.has(r['tenant_id'] as string))
  }

  /** Resolve a known core table to its store array, else fall through to a generic domain table. */
  private namedTable(table: string): Array<Record<string, unknown>> {
    switch (table) {
      case 'tenants':
        return this.store.tenants as unknown as Array<Record<string, unknown>>
      case 'memberships':
        return this.store.memberships as unknown as Array<Record<string, unknown>>
      case 'participant_accounts':
        return this.store.participantAccounts as unknown as Array<Record<string, unknown>>
      case 'plugin_activations':
        return this.store.pluginActivations as unknown as Array<Record<string, unknown>>
      default:
        return this.store.table(table)
    }
  }
}

export class MemoryDatabase implements Database {
  constructor(private readonly store: MemoryStore) {}

  forRequest(req: Request): RequestDb {
    const actorHeader = req.headers.get(MEMORY_ACTOR_HEADER)
    const resolved = resolveActor(actorHeader)
    return {
      // `user()` runs AS the resolved caller — RLS-filtered. If the request had no actor, this is effectively
      // anonymous (empty visible-tenant set), which is the safe default.
      user: () => new MemoryScopedDb(this.store, resolved),
      anon: () => new MemoryScopedDb(this.store, { role: 'anon', userId: null }),
      service: () => new MemoryScopedDb(this.store, { role: 'service', userId: null }),
    }
  }

  service(): ScopedDb {
    return new MemoryScopedDb(this.store, { role: 'service', userId: null })
  }
}

export function createMemoryDatabase(store: MemoryStore): MemoryDatabase {
  return new MemoryDatabase(store)
}

/** Map the actor header to an `Actor`: `@service` → bypass, a uuid → user, absent/empty → anon. */
function resolveActor(header: string | null): Actor {
  if (!header) return { role: 'anon', userId: null }
  if (header === MEMORY_SERVICE_ACTOR) return { role: 'service', userId: null }
  return { role: 'user', userId: header }
}

/** Drop a `schema.` prefix so `core.memberships` and `memberships` resolve to the same store table. */
function stripSchema(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(dot + 1)
}
