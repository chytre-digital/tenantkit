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

/** Minimal cookie port so this file doesn't hard-depend on `next/headers` (the @tenantkit/next binding wires it). */
export interface CookieAdapter {
  getAll(): { name: string; value: string }[]
  setAll(cookies: { name: string; value: string; options?: Record<string, unknown> }[]): void
}

/** A no-op cookie store for read-only contexts (RSC where cookies can't be set; the proxy refreshes them). */
export const readOnlyCookies = (all: { name: string; value: string }[]): CookieAdapter => ({
  getAll: () => all,
  setAll: () => {
    /* ignored — Server Component context; middleware refreshes the session */
  },
})

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
