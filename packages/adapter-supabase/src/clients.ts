/**
 * The raw Supabase client factories — the ONE place @supabase/* is imported. Everything else in this adapter
 * builds on these. Three roles, mirroring the four-factory pattern from the reference apps, here consolidated:
 *
 *   • userClient(req)  — cookie-bound SSR client; RLS runs AS the signed-in user. PostgREST injects the JWT,
 *                        so `core.current_user_id()` resolves with ZERO extra work (no SET LOCAL needed).
 *   • anonClient()     — anon role; RLS applies, no identity (public catalogue reads).
 *   • adminClient()    — service role; BYPASSES RLS. Server-only singleton. Re-check authz in code.
 *
 * Cookie handling is the only Next.js-specific seam; it is injected so a non-Next host can supply its own.
 */
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseEnv } from './env'
// CookieAdapter is a VENDOR-FREE kernel type — the adapter (and @tenantkit/next) reuse it; neither owns it.
import { type CookieAdapter, readOnlyCookies } from '@tenantkit/kernel'

export { type CookieAdapter, readOnlyCookies } // re-export for this adapter's consumers

/** Cookie-bound client: every query runs under the caller's RLS identity (JWT from the cookie). */
export function userClient(cookies: CookieAdapter): SupabaseClient {
  const env = supabaseEnv()
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookies.getAll(),
      setAll: (toSet) => cookies.setAll(toSet),
    },
  })
}

/** anon-role client: no session, RLS still enforced. Safe for public reads. */
export function anonClient(): SupabaseClient {
  const env = supabaseEnv()
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

let admin: SupabaseClient | null = null
/** service-role client: BYPASSES RLS. Singleton, server-only. Throws if the service key is absent. */
export function adminClient(): SupabaseClient {
  if (admin) return admin
  const env = supabaseEnv()
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('[adapter-supabase] SUPABASE_SERVICE_ROLE_KEY is required for service-role access')
  }
  admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return admin
}
