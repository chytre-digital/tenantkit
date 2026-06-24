/**
 * The composition root: assemble a kernel `CoreRuntime` once, from adapters. Everything else (routes, use-cases)
 * reads from it. Swap `createSupabaseRuntime` for a Postgres/Auth.js runtime and nothing downstream changes.
 */
import { createSupabaseRuntime } from '@tenantkit/adapter-supabase'
import { createResendEmail } from '@tenantkit/email-resend'
import { nextCookies } from '@tenantkit/next'

export const runtime = createSupabaseRuntime({
  email: createResendEmail({ from: 'Example <no-reply@example.com>' }),
  cookies: nextCookies,
})
