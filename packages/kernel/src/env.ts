/**
 * Realizes docs/01-architecture.md §8 (Environments & configuration) — the VENDOR-FREE kernel env.
 *
 * The kernel itself needs almost nothing from the environment (it talks to the world only through ports). Vendor
 * secrets live in the ADAPTER packages and are validated there: `@tenantkit/adapter-supabase` owns
 * `SUPABASE_*`, `@tenantkit/email-resend` owns `RESEND_API_KEY`, `@tenantkit/payments-stripe` owns `STRIPE_*`.
 * Importing the kernel must NEVER throw on a missing vendor key. Apps extend this with their own keys via
 * `EnvSchema.extend({...})`.
 */
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().optional(),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`[tenantkit] Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

/** Validated, frozen kernel environment (only NODE_ENV + optional APP_URL — never vendor secrets). */
export const env: Env = Object.freeze(loadEnv())

export { EnvSchema }
