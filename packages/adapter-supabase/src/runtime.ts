/**
 * `createSupabaseRuntime()` — the one call that assembles a kernel `CoreRuntime` from Supabase. This is what
 * makes the adapter "drop-in": pass an EmailProvider (and optionally a PaymentProvider/StorageProvider) and you
 * get a fully-wired runtime that `withRoute()` consumes. Email & payments are SEPARATE adapters by design —
 * Supabase is your DB + auth + storage; Resend/Stripe/etc. are yours to choose.
 */
import type { CookieAdapter } from './clients'
import type { Clock, CoreRuntime, EmailProvider, IdGen, PaymentProvider, StorageProvider } from '@deverjak/tenantkit-kernel'
import { createSupabaseDatabase } from './database'
import { createSupabaseIdentity } from './identity'
import { createSupabaseSessionStore } from './session'
import { createSupabaseAuthzStore } from './authz'
import { createSupabaseStorage } from './storage'

export interface SupabaseRuntimeOptions {
  /** REQUIRED — transactional email (e.g. @deverjak/tenantkit-email-resend). Supabase doesn't own your templates. */
  email: EmailProvider
  /** A writable cookie adapter factory for the current request. @deverjak/tenantkit-next supplies one over next/headers. */
  cookies: () => Promise<CookieAdapter>
  /** OPTIONAL — the payments plugin's provider (e.g. @deverjak/tenantkit-payments-stripe). */
  payments?: PaymentProvider
  /** OPTIONAL — override storage (defaults to Supabase Storage). */
  storage?: StorageProvider
  clock?: Clock
  ids?: IdGen
}

export function createSupabaseRuntime(opts: SupabaseRuntimeOptions): CoreRuntime {
  return {
    identity: createSupabaseIdentity({ cookies: opts.cookies }),
    sessions: createSupabaseSessionStore(),
    db: createSupabaseDatabase(),
    authz: createSupabaseAuthzStore(),
    email: opts.email,
    payments: opts.payments,
    storage: opts.storage ?? createSupabaseStorage(),
    clock: opts.clock ?? { now: () => new Date() },
    ids: opts.ids ?? defaultIds(),
  }
}

function defaultIds(): IdGen {
  return {
    uuid: () => crypto.randomUUID(),
    token: (bytes = 32) => {
      const a = new Uint8Array(bytes)
      crypto.getRandomValues(a)
      return Buffer.from(a).toString('base64url')
    },
  }
}
