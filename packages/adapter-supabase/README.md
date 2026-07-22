# @deverjak/tenantkit-adapter-supabase

The **Supabase reference adapter** for the `reservation-core` / tenantkit kernel ports. One call —
`createSupabaseRuntime()` — gives you a fully‑wired `CoreRuntime` (Database, Identity, Session, Authz,
Storage) that `withRoute()` consumes. Bring your own **email** (Resend/SMTP) and, if you sell, **payments**
(Stripe); Supabase covers your DB + auth + storage.

> Why Supabase is the *reference* adapter: it implements every flow the kernel needs **natively** — password,
> magic link, OTP, OAuth, admin user creation, and RLS that reads the caller's JWT — so the mapping is thin and
> complete. Other adapters (`@deverjak/tenantkit-adapter-postgres` + `@deverjak/tenantkit-adapter-authjs`) implement the same
> ports; nothing in your app changes when you swap.

## Install

```bash
pnpm add @deverjak/tenantkit-kernel @deverjak/tenantkit-adapter-supabase @deverjak/tenantkit-email-resend
```

```bash
# .env — modern Supabase key names (legacy SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are also accepted)
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   # browser-safe; RLS-enforced
SUPABASE_SECRET_KEY=sb_secret_...                         # server-only — bypasses RLS, never ship to the browser
RESEND_API_KEY=re_...                                     # only if you use @deverjak/tenantkit-email-resend
```

## Which keys do you need?

The adapter uses **two** Supabase API keys and `SUPABASE_URL`. It accepts both the **new** key names
(`*_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`) and the **legacy** ones (`SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY`); the `NEXT_PUBLIC_*` variants are read too (required by the Edge proxy/middleware).

| You want to… | Key needed | Env var |
|---|---|---|
| **Auth** — sign in / sign up / magic link / OAuth / session refresh | **publishable** (anon) | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| **Tables as the signed-in user** — RLS-scoped reads/writes (`ctx.db.user()`) | **publishable** (anon) | *(same — the user's JWT rides the cookie)* |
| **Public / anon table reads** (`ctx.db.anon()`) | **publishable** (anon) | *(same)* |
| **The tenant layer** — `resolveClaims` (memberships, profiles), `provisionTenant`, plugin activation, tenant tier | **secret** (service-role) | `SUPABASE_SECRET_KEY` |
| **Storage** — logos / exports (`StorageProvider`) | **secret** (service-role) | `SUPABASE_SECRET_KEY` |
| **Admin** — invite staff (`createUser`), mint magic links (`createMagicLink`) | **secret** (service-role) | `SUPABASE_SECRET_KEY` |
| **Rate limits / webhooks / cron** (`Database.service()`) | **secret** (service-role) | `SUPABASE_SECRET_KEY` |

**Rule of thumb:** the **publishable key alone** runs all user-facing **auth + RLS-scoped data**. Add the
**secret key** the moment you touch the **tenant/authz layer, storage, admin user creation, or any service-role
work** — it bypasses RLS, so keep it **server-only** (never in a `NEXT_PUBLIC_*` var or the browser bundle).

> The project's **JWT secret** is *not* used by this adapter — it authenticates with the API keys above, it does
> not verify JWTs itself. You only need the JWT secret if you verify Supabase tokens manually elsewhere.

## Wire it (≈12 lines)

```ts
// app/server/runtime.ts
import { cookies } from 'next/headers'
import { createSupabaseRuntime } from '@deverjak/tenantkit-adapter-supabase'
import { createResendEmail } from '@deverjak/tenantkit-email-resend'

export const runtime = createSupabaseRuntime({
  email: createResendEmail({ from: 'Acme <no-reply@acme.com>' }),
  // next/headers → the CookieAdapter the SSR client needs
  cookies: async () => {
    const store = await cookies()
    return {
      getAll: () => store.getAll(),
      setAll: (cs) => cs.forEach((c) => store.set(c.name, c.value, c.options)),
    }
  },
})
```

```ts
// app/api/courses/route.ts — a real route, RLS-enforced
import { withRoute, jsonOk } from '@deverjak/tenantkit-kernel'
import { runtime } from '@/server/runtime'

export const POST = withRoute(
  { runtime, audience: 'staff', minRole: 'coach', can: 'courses:create', tenantFrom: 'cookie', body: CreateCourseSchema },
  async (ctx) => {
    // ctx.db.user() is the caller's RLS-scoped Supabase handle; the INSERT can't escape their tenant.
    const course = await ctx.db.user().rpc('create_course', ctx.input.body)
    return jsonOk({ course })
  },
)
```

That's it. The session cookie carries the user's JWT, PostgREST sets `request.jwt.claims`, and the kernel's
`core.current_user_id()` resolves automatically — **no `SET LOCAL`, no service key in the request path.**

## Request authentication — web cookie + mobile Bearer

By default the adapter authenticates the **web session cookie** — unchanged, zero config. To let a **mobile
client** (Expo) call the *same* Route Handlers with a Supabase **access token**, opt in with `requestAuth`:

| `mode` | Web session cookie | `Authorization: Bearer …` |
|---|---|---|
| `'cookie'` *(default)* | ✅ | ignored |
| `'bearer'` | ignored | ✅ |
| `'cookie-or-bearer'` | ✅ (fallback) | ✅ (**wins** when present) |

```ts
export const runtime = createSupabaseRuntime({
  email,
  cookies: nextCookies,
  requestAuth: { mode: 'cookie-or-bearer' }, // web keeps cookies; mobile sends a Bearer token
})
```

The **same** credential drives BOTH the guard (`ctx.claims`) and the RLS DB scope (`ctx.db.user()`), so they can
never disagree. **Your Route Handlers don't change** — `withSlugRoute()` works identically for both transports:

```ts
export const GET = withSlugRoute(
  { runtime, audience: 'staff', can: 'things:read' },
  async (ctx) => {
    // RLS as the Bearer/cookie caller — no service key in the request path.
    const rows = await ctx.db.user().rpc('list_things', { tenant_id: ctx.tenantId })
    return jsonOk({ rows })
  },
)
```

**Expo client** — send the access token; the mobile client owns login **and** refresh:

```ts
const { data } = await supabase.auth.getSession()
const accessToken = data.session?.access_token
if (!accessToken) throw new Error('sign in first') // guard: never send the string `Bearer undefined`

await fetch(`${apiBaseUrl}/api/v1/t/${tenantSlug}/mobile/bootstrap`, {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
})
```

Guarantees:

- **RLS everywhere.** The Bearer token rides `Authorization` on the **publishable/anon** key — *never* the
  service-role key. Don't substitute `ctx.db.service()` for a user's domain query; it bypasses RLS.
- **401, not 500.** A missing / expired / corrupt token → `401 UNAUTHORIZED`; a role/permission denial → `403`,
  identically for cookie and Bearer.
- **No cookies for mobile.** A Bearer request emits **no `Set-Cookie`**, and the server never refreshes it — the
  Expo/Supabase client refreshes its own session. `signOut` stays a cookie/web concern (mobile clears locally).
- **A malformed header never silently downgrades.** In a bearer-enabled mode a present-but-broken `Authorization`
  header is treated as unauthenticated (`401`); it does **not** fall back to the cookie.

**Migration:** the default is still `'cookie'` — existing apps are byte-for-byte unchanged until they opt in.

> **Testing this adapter against real RLS:** the conformance suite runs the full port suite (cookie **and**
> Bearer) plus a security matrix against a disposable Supabase project. See
> [`src/__tests__/conformance.test.ts`](./src/__tests__/conformance.test.ts) and the fixtures it needs
> ([`conformance.fixtures.sql`](./src/__tests__/conformance.fixtures.sql)); it self-skips without the
> `SUPABASE_URL` / anon / service-role env, so the repo stays green offline.

## What each kernel port maps to

| Kernel port | Supabase mapping |
|---|---|
| `Database.forRequest(req).user()` | RLS **as the caller** — from the request's JWT (session cookie *or* `Authorization: Bearer`, per `requestAuth`) |
| `Database.forRequest(req).anon()` | anon client — public catalogue reads |
| `Database.forRequest(req).service()` / `Database.service()` | service‑role client — **bypasses RLS** (webhooks/cron) |
| `ScopedDb.rpc(fn, args)` | `supabase.rpc(...)` — your SECURITY DEFINER functions (e.g. `redeem_credit_into_session`) |
| `ScopedDb.client` *(escape hatch)* | the raw `SupabaseClient` for idiomatic `.from()` on your own tables |
| `IdentityProvider.*` | `supabase.auth.*` — password / magic link (via `admin.generateLink`) / OTP / OAuth / `admin.createUser` |
| `SessionStore.refresh()` | the `updateSession` cookie‑rotation pattern (call it in middleware) |
| `AuthzStore.*` | service‑role reads of `core.{profiles,memberships,participant_accounts,plugin_activations,tenants}` keyed by the verified `userId` |
| `StorageProvider.put/signedUrl/remove` | `supabase.storage.from(bucket).upload / createSignedUrl / remove` |
| `StorageProvider.createSignedUpload?` *(optional)* | `createSignedUploadUrl(key, { upsert })` — a direct-upload PUT target (see below) |
| `StorageProvider.stat?` *(optional)* | `storage.from(bucket).info(key)` — object metadata, or `null` if absent |

### Direct uploads — client bytes never touch the app server

For large blobs (e.g. a mobile app posting a field photo), don't stream through your Route Handler. Mint a
**pre-signed upload target** server-side and hand it to the client, which PUTs straight to Supabase Storage:

```ts
// server: a withSlugRoute() handler, authorized as usual
const target = await ctx.runtime.storage!.createSignedUpload({
  bucket: 'evidence', key: `jobs/${jobId}/before.jpg`, contentType: 'image/jpeg', expiresInSec: 900, upsert: false,
})
return jsonOk({ target }) // { url, method: 'PUT', headers, expiresAt }
```

```ts
// client (e.g. Expo): upload the bytes directly — no server round-trip for the payload
await fetch(target.url, { method: target.method, headers: target.headers, body: fileBytes })
```

`createSignedUpload` and `stat` are **optional** capabilities — feature-detect (`if (runtime.storage?.createSignedUpload)`)
since other adapters may not implement them. Two guarantees to know:

- **Service-role, but scoped by you.** The signed target is minted with the service-role key, so the *route*
  that calls `createSignedUpload` must authorize the caller and constrain `bucket`/`key` — the framework signs
  the transport, your app owns the policy (which object, size/type limits, before/after semantics, EXIF, AV,
  thumbnails, reward logic all stay in your app).
- **Supabase caps the upload window itself.** Supabase does not accept a per-URL upload expiry; its upload
  tokens have a fixed server-side TTL (default ~2h). `expiresInSec` only sets the advertised `expiresAt`, so
  keep it within that window. (Download URLs via `signedUrl()` **do** honor `expiresInSec`.)

## Database setup (one migration)

The kernel ships its schema + RLS. Apply, in order: **(1)** the kernel core migration (creates `core.*`, the
RLS predicates, `core.current_user_id()`), **(2)** your app/domain migrations, **(3)** *optionally*
[`./supabase/0000_current_user_id_supabase.sql`](./supabase/0000_current_user_id_supabase.sql) if you want to
alias `current_user_id()` to Supabase's native `auth.uid()` (Option B in that file). The portable default needs
no Supabase‑specific SQL at all.

**Supabase project settings:**
- **Project → API → Exposed schemas:** add `core` so the adapter's `.schema('core')` reads work — *or* keep
  `core` private and expose only RPCs (more locked‑down; the adapter then reads via `rpc()`).
- **Auth → Email:** if you mint magic links with `admin.generateLink()` and send them via Resend (recommended,
  so *you* own the template), disable Supabase's built‑in magic‑link email; or point Supabase SMTP at Resend.

## Honest limitations (so nothing surprises you)

- **No client‑side transactions.** PostgREST can't `BEGIN…COMMIT` from the client, so `ScopedDb.tx()` runs
  inline. For real atomicity (overbooking guard, credit redeem) call a **SECURITY DEFINER RPC** via `rpc()` —
  which is exactly what the spec does (`redeem_credit_into_session`).
- **No raw `query()`** on `user`/`anon` scopes (PostgREST, not SQL). Use `.from()` via `ScopedDb.client`, or an
  RPC. Driver adapters (`@deverjak/tenantkit-adapter-postgres`) do implement raw `query()`.
- **Cookie writing** is the one Next.js‑shaped seam; `@deverjak/tenantkit-next` supplies the `cookies()` factory for
  you. A non‑Next host passes its own `CookieAdapter`.
- **Service role bypasses RLS** — the adapter fences it to `AuthzStore`/webhooks/cron; your code using
  `Database.service()` must re‑check authorization.

## Use it à la carte

Don't want the whole runtime? Import a single factory — e.g. keep Supabase for the DB but bring a different
IdentityProvider:

```ts
import { createSupabaseDatabase, createSupabaseAuthzStore } from '@deverjak/tenantkit-adapter-supabase'
const runtime = { db: createSupabaseDatabase(), authz: createSupabaseAuthzStore(), identity: myAuthjsIdentity, /* … */ }
```

MIT. Part of the tenantkit kernel family — see the platform spec, `docs/14-portability-and-providers.md`.
