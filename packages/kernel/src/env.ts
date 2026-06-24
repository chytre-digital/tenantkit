/**
 * Realizes docs/01-architecture.md §8 (Environments & configuration).
 *
 * Zod-validated, fail-fast environment. All secrets are env vars, validated at boot — a missing or malformed
 * value throws here (at import time) rather than surfacing as a confusing runtime error deep in a request.
 *
 * The Supabase env-var NAME is the one thing the legacy apps hardcoded non-standardly
 * (`…PUBLISHABLE_DEFAULT_KEY`); the core parameterizes it to the conventional names below.
 */
import { z } from 'zod'

const EnvSchema = z.object({
  // --- Supabase (doc 01 §4) ---
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  /** Service role — server-only, bypasses RLS. NEVER shipped to the client bundle (read by the DB adapter). */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // --- Email (doc 10) — optional so local/preview can run without it; sendEmail() returns `skipped`. ---
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().default('Reservation <no-reply@example.com>'),

  // --- Misc ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().optional(),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    // Fail fast and loud: surface exactly which keys are missing/invalid, then abort the boot.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`[reservation-core] Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

/** Validated, frozen environment. Importing this module is the boot-time gate. */
export const env: Env = Object.freeze(loadEnv())

/** Apps may extend the base schema with their own keys: `defineApp({ env: EnvSchema.extend({...}) })`. */
export { EnvSchema }
