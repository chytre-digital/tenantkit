/**
 * Adapter conformance — the bar from the framework's CONTRIBUTING: this adapter is "done" when it passes the
 * SAME port conformance suite the in-memory runtime does (`@deverjak/tenantkit-testing`), but against REAL Postgres RLS.
 *
 * Requires a throwaway Supabase project with the kernel core migration applied (creates core.* + the RLS
 * predicates + core.current_user_id) and these env vars: SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY. Skipped when absent so the repo stays green offline; CI runs it in an integration
 * lane against a disposable project.
 */
import { describe } from 'vitest'
import { runAllConformance, type ConformanceHarness } from '@deverjak/tenantkit-testing/conformance'

const hasEnv = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)

describe.skipIf(!hasEnv)('@deverjak/tenantkit-adapter-supabase — port conformance (real Postgres RLS)', () => {
  runAllConformance(async (): Promise<ConformanceHarness> => {
    // Build a harness over the Supabase adapter against the test project:
    //  • runtime: createSupabaseRuntime({ email: <stub EmailProvider>, cookies: <test cookie store> })
    //  • seedUserWithMembership: admin client → auth.admin.createUser + create_tenant_with_owner RPC
    //  • requestAs(userId): sign that user in, capture the session cookie, attach it to a fresh Request
    //  • anonRequest: a Request with no cookie
    // See README › "Conformance" for the full harness.
    throw new Error('TODO: wire the Supabase conformance harness (admin-client seed + real session cookie).')
  })
})
