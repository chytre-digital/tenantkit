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
import type { Database, RequestDb, ScopedDb } from '@deverjak/tenantkit-kernel' // == packages/reservation-core/src/ports
import { adminClient, anonClient, bearerUserClient, readOnlyCookies, userClient } from './clients'
import { type SupabaseRequestAuthOptions, normalizeRequestAuth, resolveRequestCredential } from './request-auth'

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
  private readonly requestAuth: SupabaseRequestAuthOptions
  constructor(requestAuth?: SupabaseRequestAuthOptions) {
    this.requestAuth = normalizeRequestAuth(requestAuth)
  }

  forRequest(req: Request): RequestDb {
    // Resolve the credential ONCE per request so `user()` never disagrees with the identity guard.
    const credential = resolveRequestCredential(req, this.requestAuth)
    const userClientForCredential = (): SupabaseClient => {
      if (credential.kind === 'bearer') return bearerUserClient(credential.accessToken)
      if (credential.kind === 'cookie') {
        return userClient(readOnlyCookies(parseCookieHeader(req.headers.get('cookie'))))
      }
      // `invalid` (bad Bearer) or `anonymous` — NEVER fall back to the cookie; run unauthenticated so RLS
      // sees no user. In the normal pipeline the identity guard has already produced a 401 before this runs.
      return anonClient()
    }
    return {
      user: () => new SupabaseScopedDb(userClientForCredential()),
      anon: () => new SupabaseScopedDb(anonClient()),
      service: () => new SupabaseScopedDb(adminClient()),
    }
  }

  service(): ScopedDb {
    return new SupabaseScopedDb(adminClient())
  }
}

export const createSupabaseDatabase = (requestAuth?: SupabaseRequestAuthOptions): SupabaseDatabase =>
  new SupabaseDatabase(requestAuth)

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return []
  return header.split(';').map((pair) => {
    const idx = pair.indexOf('=')
    const name = pair.slice(0, idx).trim()
    const value = decodeURIComponent(pair.slice(idx + 1).trim())
    return { name, value }
  })
}
