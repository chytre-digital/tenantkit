/**
 * `Database` port → Supabase. Implements `forRequest(req).{user,anon,service}()` and out-of-band `service()`.
 *
 * The elegant part of the Supabase mapping: `user()` is the cookie-bound client, so RLS runs as the caller
 * with NO `SET LOCAL` — PostgREST injects `request.jwt.claims` and `core.current_user_id()` just works.
 *
 * Honest limitation surfaced by this adapter: PostgREST has no client-side interactive transaction, so `tx()`
 * runs the callback without a real BEGIN/COMMIT. For genuine atomicity (the overbooking guard, credit redeem),
 * the spec already routes through SECURITY DEFINER RPCs (`redeem_credit_into_session`) — call them via `rpc()`.
 * Raw `query()` is intentionally omitted on Supabase scopes (no arbitrary SQL over PostgREST); use `.client`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, RequestDb, ScopedDb } from '@tenantkit/kernel' // == packages/reservation-core/src/ports
import { adminClient, anonClient, readOnlyCookies, userClient } from './clients'

/** Concrete ScopedDb that also exposes `.client` — the escape hatch for idiomatic `.from()` on Supabase apps. */
export class SupabaseScopedDb implements ScopedDb {
  constructor(public readonly client: SupabaseClient) {}

  async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args)
    if (error) throw error // surfaces as PostgrestError → mapped to HTTP by the kernel's jsonError
    return data as T
  }

  /** No real transaction over PostgREST — run inline. Use a SECURITY DEFINER RPC when you need atomicity. */
  async tx<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

export class SupabaseDatabase implements Database {
  forRequest(req: Request): RequestDb {
    const cookies = readOnlyCookies(parseCookieHeader(req.headers.get('cookie')))
    return {
      user: () => new SupabaseScopedDb(userClient(cookies)),
      anon: () => new SupabaseScopedDb(anonClient()),
      service: () => new SupabaseScopedDb(adminClient()),
    }
  }

  service(): ScopedDb {
    return new SupabaseScopedDb(adminClient())
  }
}

export const createSupabaseDatabase = (): SupabaseDatabase => new SupabaseDatabase()

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return []
  return header.split(';').map((pair) => {
    const idx = pair.indexOf('=')
    const name = pair.slice(0, idx).trim()
    const value = decodeURIComponent(pair.slice(idx + 1).trim())
    return { name, value }
  })
}
