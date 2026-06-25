/**
 * Supabase adapter env — validated once, fail-fast. The publishable key is named per the conventional
 * `SUPABASE_ANON_KEY` (the reference apps used a non-standard name; we normalize it here).
 */
import { z } from 'zod'

const Schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  /** Server-only. NEVER exposed to the browser bundle. Bypasses RLS. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
})

export type SupabaseEnv = z.infer<typeof Schema>

let cached: SupabaseEnv | null = null
export function supabaseEnv(): SupabaseEnv {
  if (cached) return cached
  const parsed = Schema.safeParse({
    SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  })
  if (!parsed.success) {
    throw new Error(`[adapter-supabase] invalid env:\n${parsed.error.issues.map((i) => ` - ${i.path}: ${i.message}`).join('\n')}`)
  }
  cached = parsed.data
  return cached
}
