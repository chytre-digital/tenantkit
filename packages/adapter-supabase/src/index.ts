/**
 * @deverjak/tenantkit-adapter-supabase — Supabase reference adapter for the kernel ports.
 *
 * Most apps need only `createSupabaseRuntime()`. The individual factories are exported for partial use
 * (e.g. keep Supabase for DB but bring your own IdentityProvider). Provisional scope `@deverjak/tenantkit-*` (ADR-0010).
 */
export { createSupabaseRuntime, type SupabaseRuntimeOptions } from './runtime'
export { createSupabaseDatabase, SupabaseDatabase, SupabaseScopedDb } from './database'
export { createSupabaseIdentity, SupabaseIdentity, type SupabaseIdentityDeps } from './identity'
export { createSupabaseSessionStore, SupabaseSessionStore } from './session'
export { createSupabaseAuthzStore, SupabaseAuthzStore } from './authz'
export { createSupabaseStorage, SupabaseStorage } from './storage'
export { type CookieAdapter, userClient, bearerUserClient, anonClient, adminClient, readOnlyCookies } from './clients'
export {
  resolveRequestCredential,
  normalizeRequestAuth,
  type SupabaseRequestAuthMode,
  type SupabaseRequestAuthOptions,
  type RequestCredential,
} from './request-auth'
export { supabaseEnv, type SupabaseEnv } from './env'
