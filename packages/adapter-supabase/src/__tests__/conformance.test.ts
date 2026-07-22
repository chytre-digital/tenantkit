/**
 * Adapter conformance — the bar from the framework's CONTRIBUTING: this adapter is "done" when it passes the
 * SAME port conformance suite the in-memory runtime does (`@deverjak/tenantkit-testing`), but against REAL
 * Postgres RLS — run once for the COOKIE transport and once for the BEARER transport (the mobile/Expo path).
 * On top of the shared suite it pins the hybrid cookie/Bearer specifics: identity↔DB credential consistency
 * (spec §5.2) and the integration security matrix (spec §5.4).
 *
 * SETUP — a throwaway/disposable Supabase project with:
 *   1. the kernel core migration applied (db/migrations/0001_core.sql — core.* + RLS predicates + current_user_id),
 *   2. the conformance fixtures applied (./conformance.fixtures.sql — public.courses + count_courses),
 *   3. the `core` schema exposed (Project → API → Exposed schemas) so the harness can seed via `.schema('core')`.
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (or *_PUBLISHABLE_KEY), SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).
 * Skipped when absent so the repo stays green offline; CI runs it in an integration lane against a disposable project.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServerClient } from '@supabase/ssr'
import {
  type EmailProvider,
  defineRoles,
  jsonOk,
  resolveClaims,
  withSlugRoute,
} from '@deverjak/tenantkit-kernel'
import { runAllConformance, type ConformanceHarness } from '@deverjak/tenantkit-testing/conformance'
import { createSupabaseRuntime } from '../runtime'
import { adminClient } from '../clients'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const ANON_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  ''
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const hasEnv = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY)

const URL = 'https://api.test.local/api/v1/t/acme/things'
const PASSWORD = 'conformance-Test-Password-123!'

// The sample role vocabulary (mirrors the in-memory harness): the rank ladder that `minRole` gates read, and the
// keys the harness seeds into core.roles.
const ROLE_DEFS = [
  { key: 'staff', rank: 1 },
  { key: 'coach', rank: 2 },
  { key: 'admin', rank: 3, isAdmin: true },
  { key: 'owner', rank: 4, isOwner: true, isAdmin: true },
] as const

// A never-throwing email stub — the EmailProvider conformance case only asserts the result shape.
const stubEmail: EmailProvider = {
  async send() {
    return { status: 'skipped', reason: 'conformance stub' }
  },
}

// ── request-scoped cookie holder ────────────────────────────────────────────────────────────────────────────
// SupabaseIdentity's cookie branch reads cookies from the injected `cookies()` factory (not from `req`), whereas
// the DB scope reads them off the request. For the COOKIE transport we point the factory at the "current" user's
// cookies, set synchronously by `requestAs` right before the suite drives identity/db. The conformance suites run
// sequentially (no `.concurrent`), so a single mutable holder is safe.
let currentCookies: { name: string; value: string }[] = []

const runtime = createSupabaseRuntime({
  email: stubEmail,
  cookies: async () => ({
    getAll: () => currentCookies,
    setAll: () => {
      /* read-only in tests */
    },
  }),
  requestAuth: { mode: 'cookie-or-bearer' },
})

const admin = hasEnv ? adminClient() : (null as never)

type Signed = { accessToken: string; cookieHeader: string; cookies: { name: string; value: string }[] }

const sessions = new Map<string, Signed>()
const emailToUserId = new Map<string, string>()
const createdUserIds = new Set<string>()
const createdTenantIds = new Set<string>()
let rolesSeeded = false

/** Seed the role vocabulary into core.roles once (idempotent upsert). */
async function seedRolesOnce(): Promise<void> {
  if (rolesSeeded) return
  const rows = ROLE_DEFS.map((r) => ({
    key: r.key,
    rank: r.rank,
    label: r.key,
    is_admin: 'isAdmin' in r ? r.isAdmin : false,
    is_owner: 'isOwner' in r ? r.isOwner : false,
  }))
  const { error } = await admin.schema('core').from('roles').upsert(rows, { onConflict: 'key' })
  if (error) throw new Error(`seed roles failed: ${error.message}`)
  rolesSeeded = true
}

/** Sign a user in through an SSR client with an in-memory cookie jar → yields BOTH the access token and cookies. */
async function signIn(email: string): Promise<Signed> {
  const jar = new Map<string, string>()
  const ssr = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (toSet) => toSet.forEach((c) => jar.set(c.name, c.value)),
    },
  })
  const { data, error } = await ssr.auth.signInWithPassword({ email, password: PASSWORD })
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
  const cookies = [...jar.entries()].map(([name, value]) => ({ name, value }))
  const cookieHeader = cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ')
  return { accessToken: data.session.access_token, cookieHeader, cookies }
}

/** Reuse a tenant by slug, or create it (service role bypasses RLS). Returns its id. */
async function ensureTenant(slug: string): Promise<string> {
  const existing = await admin.schema('core').from('tenants').select('id').eq('slug', slug).maybeSingle()
  if (existing.data?.id) {
    createdTenantIds.add(existing.data.id)
    return existing.data.id
  }
  const { data, error } = await admin
    .schema('core')
    .from('tenants')
    .insert({ slug, name: slug })
    .select('id')
    .single()
  if (error || !data) throw new Error(`create tenant ${slug} failed: ${error?.message}`)
  createdTenantIds.add(data.id)
  return data.id
}

/** Delete a previously-seeded user for this email (keeps the SAME email/slug free across the two transport runs). */
async function purgeUserByEmail(email: string): Promise<void> {
  const prior = emailToUserId.get(email)
  if (!prior) return
  await admin.schema('core').from('memberships').delete().eq('user_id', prior)
  try {
    await admin.auth.admin.deleteUser(prior)
  } catch {
    /* best effort */
  }
  createdUserIds.delete(prior)
  emailToUserId.delete(email)
  sessions.delete(prior)
}

/** The adapter-agnostic seed: create a user + a tenant membership, and pre-sign so the sync `requestAs` can build requests. */
async function seedUserWithMembership(opts: {
  email: string
  role?: string
  tenantSlug?: string
}): Promise<{ userId: string; tenantId: string }> {
  await seedRolesOnce()
  const role = opts.role ?? 'staff'
  const slug = opts.tenantSlug ?? `tenant-${opts.email}`

  await purgeUserByEmail(opts.email)
  const tenantId = await ensureTenant(slug)

  const created = await admin.auth.admin.createUser({ email: opts.email, password: PASSWORD, email_confirm: true })
  if (created.error || !created.data.user) throw new Error(`createUser ${opts.email} failed: ${created.error?.message}`)
  const userId = created.data.user.id
  createdUserIds.add(userId)
  emailToUserId.set(opts.email, userId)

  const membership = await admin
    .schema('core')
    .from('memberships')
    .insert({ user_id: userId, tenant_id: tenantId, role })
  if (membership.error) throw new Error(`membership insert failed: ${membership.error.message}`)

  sessions.set(userId, await signIn(opts.email))
  return { userId, tenantId }
}

function bearerRequest(userId: string): Request {
  const s = sessions.get(userId)
  if (!s) throw new Error(`user not seeded: ${userId}`)
  return new Request(URL, { headers: { authorization: `Bearer ${s.accessToken}` } })
}

function cookieRequest(userId: string): Request {
  const s = sessions.get(userId)
  if (!s) throw new Error(`user not seeded: ${userId}`)
  currentCookies = s.cookies // point the identity cookie factory at this user
  return new Request(URL, { headers: { cookie: s.cookieHeader } })
}

function makeHarness(transport: 'cookie' | 'bearer'): ConformanceHarness {
  return {
    runtime,
    anonRequest: () => new Request(URL),
    requestAs: (userId) => (transport === 'bearer' ? bearerRequest(userId) : cookieRequest(userId)),
    seedUserWithMembership,
  }
}

beforeAll(() => {
  // The TS-side rank ladder used by minRole gates (the DB side is seeded via seedRolesOnce()).
  defineRoles(ROLE_DEFS.map((r) => ({ ...r })))
})

afterAll(async () => {
  if (!hasEnv) return
  for (const id of createdUserIds) {
    try {
      await admin.schema('core').from('memberships').delete().eq('user_id', id)
      await admin.auth.admin.deleteUser(id)
    } catch {
      /* best effort */
    }
  }
  for (const tid of createdTenantIds) {
    try {
      await admin.schema('core').from('tenants').delete().eq('id', tid) // cascades memberships + courses
    } catch {
      /* best effort */
    }
  }
})

// ── the shared port conformance suite, run against real RLS, for BOTH transports ────────────────────────────
describe.skipIf(!hasEnv)('@deverjak/tenantkit-adapter-supabase — port conformance (real Postgres RLS)', () => {
  describe('cookie transport', () => {
    runAllConformance(() => makeHarness('cookie'))
  })
  describe('bearer transport', () => {
    runAllConformance(() => makeHarness('bearer'))
  })
})

// ── hybrid cookie/Bearer specifics (spec §5.2 + §5.4) ───────────────────────────────────────────────────────
type RouteArgs = [Request, { params: unknown }]
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) })

describe.skipIf(!hasEnv)('hybrid cookie/Bearer auth — identity↔DB consistency + security matrix', () => {
  let A: { userId: string; tenantId: string }
  let B: { userId: string; tenantId: string }

  beforeAll(async () => {
    A = await seedUserWithMembership({ email: 'hybrid-a@x.cz', role: 'staff', tenantSlug: 'hybrid-a' })
    B = await seedUserWithMembership({ email: 'hybrid-b@x.cz', role: 'staff', tenantSlug: 'hybrid-b' })
    // A course row in B's tenant, so cross-tenant RLS isolation is actually testable (not vacuously 0).
    const ins = await admin.from('courses').insert({ tenant_id: B.tenantId })
    if (ins.error) throw new Error(`seed course failed: ${ins.error.message}`)
  })

  it('§5.2 — Bearer wins over a conflicting cookie for BOTH the guard and the DB scope', async () => {
    const sa = sessions.get(A.userId)!
    const sb = sessions.get(B.userId)!
    // Cookie belongs to B, Bearer to A, on a cookie-or-bearer runtime.
    currentCookies = sb.cookies
    const req = new Request(URL, {
      headers: { cookie: sb.cookieHeader, authorization: `Bearer ${sa.accessToken}` },
    })

    const claims = await resolveClaims(req, runtime)
    expect(claims.userId).toBe(A.userId) // guard resolves A, not B

    // The RLS DB scope must ALSO be A: counting B's tenant as A returns 0 (A is not a member of B).
    const asUser = await runtime.db.forRequest(req).user().rpc<{ count: number }>('count_courses', {
      tenant_id: B.tenantId,
    })
    expect(asUser.count).toBe(0)
  })

  it('§5.4 — Bearer request never uses the service-role client for a domain query (RLS holds)', async () => {
    // If the domain scope silently fell back to service-role, this would see B's row. RLS-as-A → 0.
    const reqA = bearerRequest(A.userId)
    const asUser = await runtime.db.forRequest(reqA).user().rpc<{ count: number }>('count_courses', {
      tenant_id: B.tenantId,
    })
    expect(asUser.count).toBe(0)
    // sanity: the service scope DOES see it (proves the row exists and RLS is what hid it from A).
    const asService = await runtime.db.service().rpc<{ count: number }>('count_courses', { tenant_id: B.tenantId })
    expect(asService.count).toBeGreaterThanOrEqual(1)
  })

  it('§5.4 — valid staff token + own slug → 200; token A + slug B → 403 NOT_A_MEMBER', async () => {
    const route = withSlugRoute<RouteArgs>({ runtime }, async (ctx) => jsonOk({ role: ctx.role }))
    const ok = await route(bearerRequest(A.userId), params({ slug: 'hybrid-a' }))
    expect(ok.status).toBe(200)
    const cross = await route(bearerRequest(A.userId), params({ slug: 'hybrid-b' }))
    expect(cross.status).toBe(403)
    expect((await cross.json()).code).toBe('NOT_A_MEMBER')
  })

  it('§5.4 — insufficient role → 403 FORBIDDEN (Bearer transport)', async () => {
    const adminRoute = withSlugRoute<RouteArgs>({ runtime, minRole: 'admin' }, async (ctx) => jsonOk({ role: ctx.role }))
    const denied = await adminRoute(bearerRequest(A.userId), params({ slug: 'hybrid-a' })) // A is 'staff' < 'admin'
    expect(denied.status).toBe(403)
    expect((await denied.json()).code).toBe('FORBIDDEN')
  })

  it('§5.4 — a garbage/corrupt token → 401 UNAUTHORIZED (never 500)', async () => {
    const route = withSlugRoute<RouteArgs>({ runtime }, async () => jsonOk({}))
    const req = new Request(URL, { headers: { authorization: 'Bearer not.a.real.jwt' } })
    const res = await route(req, params({ slug: 'hybrid-a' }))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
    // (An EXPIRED token follows the identical path — GoTrue rejects it and getCurrentUser returns null → 401.)
  })

  it('§5.4 — a malformed Authorization header does NOT fall back to cookie → 401', async () => {
    const sb = sessions.get(B.userId)!
    currentCookies = sb.cookies
    const route = withSlugRoute<RouteArgs>({ runtime }, async () => jsonOk({}))
    // Present-but-empty Bearer alongside a valid cookie: must be treated as unauthenticated, not as user B.
    const req = new Request(URL, { headers: { authorization: 'Bearer ', cookie: sb.cookieHeader } })
    const res = await route(req, params({ slug: 'hybrid-b' }))
    expect(res.status).toBe(401)
  })

  it('§5.4 — no header and no cookie on a staff route → 401 UNAUTHORIZED', async () => {
    const route = withSlugRoute<RouteArgs>({ runtime }, async () => jsonOk({}))
    const res = await route(new Request(URL), params({ slug: 'hybrid-a' }))
    expect(res.status).toBe(401)
  })

  it('§5.4 — a Bearer-only request emits NO Set-Cookie (server does not refresh the mobile session)', async () => {
    const res = new Response()
    const out = await runtime.sessions.refresh(bearerRequest(A.userId), res)
    expect(out).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
