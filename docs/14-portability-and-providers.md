# 14 — Portability, providers & open‑sourcing `reservation-core`

> Goal: make `reservation-core` usable with **any Postgres**, **any email service**, and **any payment
> provider**, so it can be **open‑sourced (MIT, public repo)** and useful to people far beyond our own
> products. This document audits the current coupling, states the one dependency we keep, defines the **ports**
> that remove the rest, and lays out the OSS plan. Decision recorded in
> [ADR‑0009](adr/0009-portability-ports-and-adapters.md).

## 1. The reframe: "Supabase" is five products, not one

Before deciding what to decouple, name what Supabase actually bundles — because each piece is a separate call:

| Supabase piece | What we use it for | Is it really Supabase‑specific? |
|---|---|---|
| **Postgres** | the database, schema, constraints | No — it's just Postgres. |
| **RLS** | tenant isolation, the security boundary | **No — RLS is a Postgres feature.** |
| **GoTrue (Auth)** | users, password, OAuth, magic link, OTP, JWT, `auth.uid()` | Yes — this is the real coupling. |
| **PostgREST** | the `.from().select()` data client | Partly — it's how `auth.uid()` gets set, and the JS client shape. |
| **Storage** | file uploads (logos, exports) | Yes, but peripheral. |
| **Realtime** | live attendance / notifications | Yes, but optional polish. |

So "decouple from Supabase" is **five decisions**, and only one is load‑bearing: **where does tenant isolation
live?** Ours lives in **RLS** — a Postgres feature. That single fact shapes the whole strategy.

## 2. Coupling audit (where Supabase/Resend/Stripe show up today)

Measured against the mockup in [`packages/kernel/`](../packages/kernel/):

| Surface | Files | Coupling | Decouple effort |
|---|---|---|---|
| **Email (Resend)** | `email/send.ts` | **Shallow** — one `import { Resend }` + one `emails.send()` call; already a clean `sendEmail()`/`defineEmail()` shape | **Trivial** — wrap in `EmailProvider` |
| **Payments (Stripe)** | `plugins/payments/*` | **Shallow** — already a *plugin* with a provider notion | **Easy** — formalize `PaymentProvider` |
| **Storage** | (not core‑critical) | Shallow | Easy — `StorageProvider` (optional) |
| **Data access** | `auth/require-claims.ts`, `tenancy/*`, `with-route.ts` | **Pervasive** — `supabase.from(...)`, `supabase.auth.getUser()` everywhere | **Medium** — `Database`/`AuthzStore` ports |
| **Identity / auth** | `auth/*`, `supabase/*`, the magic‑link/OTP/safe‑link flows (doc 05) | **Deep (semantics)** — GoTrue owns users, OAuth, tokens | **Hard** — `IdentityProvider` port + adapters |
| **RLS on `auth.uid()`** | `db/index.ts` (`is_member_of`, `my_role`, `guardian_can_act`) | **Deepest — it's the security model** | **Medium** — `current_user_id()` GUC indirection |
| **Framework (Next.js/React)** | `with-route.ts`, `supabase/proxy.ts`, `cache()` | Deep — *separate axis*, not Supabase | Medium — `@reservation-core/next` binding |
| **Realtime** | (optional) | Shallow | Easy — optional, skip in core |

The headline: **email and payments are already loosely coupled (easy). The hard part is auth + the
RLS‑on‑`auth.uid()` security model + the data client.** And there's a *second* coupling axis people forget:
**Next.js itself.** A truly reusable OSS core should address both.

## 3. The one dependency we keep — and why

**Postgres ≥ 14 with RLS is the single hard dependency. We keep it, and we're proud of it.**

Trying to support "any database" (MySQL, SQLite‑only, Mongo) would force tenant isolation up into application
code (a repository injecting `WHERE tenant_id = …` on every query) and throw away the database‑enforced
defense‑in‑depth that is this project's spine — one forgotten `WHERE` becomes a cross‑tenant data leak. RLS in
the database means *even a buggy handler cannot* leak across tenants. That guarantee is the product's most
valuable property and a strong OSS differentiator. So:

- **"Works with any Postgres"** — Supabase, Neon, RDS/Aurora, Railway, Fly, self‑hosted, or `postgres.app` on a
  laptop. That's an honest, achievable, attractive promise.
- **Not "works with any database."** We say so plainly. Postgres is a feature, not a limitation.

### 3.1 The unlock: `auth.uid()` → `core.current_user_id()`

The only thing tying our RLS to *Supabase* (vs. plain Postgres) is `auth.uid()`. It's a GoTrue helper equal to
`current_setting('request.jwt.claims', true)::json->>'sub'`. Replace that single call with a core‑owned
function that works on any Postgres (already applied in [`db/index.ts`](../packages/kernel/src/db/index.ts)):

```sql
-- BEFORE (Supabase-only):       where m.user_id = auth.uid()
-- AFTER  (any Postgres):        where m.user_id = core.current_user_id()

create function core.current_user_id() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub',  -- Supabase / PostgREST
    nullif(current_setting('app.user_id', true), '')                          -- direct-driver (SET LOCAL)
  )::uuid
$$;
```

How each adapter makes the identity available to RLS:

| Adapter | How `core.current_user_id()` resolves |
|---|---|
| **Supabase** | PostgREST already injects `request.jwt.claims`; nothing to do (or alias the fn to `auth.uid()`). |
| **pg / postgres.js / Drizzle / Kysely** | At the start of each request transaction: `SET LOCAL app.user_id = $1` with the authenticated id, then run queries; RLS reads it. |
| **In‑memory / test** | The fake `Database` sets the actor on its `ScopedDb`; predicates are evaluated by the same logic. |

One function, every Postgres. The ~40 RLS policies in `supabase/migrations/*` are unchanged — they already call
`core.is_member_of()` / `core.guardian_can_act()`, which now call `current_user_id()`.

## 4. Ports & adapters

Core depends **only** on interfaces in [`packages/kernel/src/ports/index.ts`](../packages/kernel/src/ports/index.ts).
Vendors are adapter packages chosen in the app's `core.config.ts`.

```
                ┌──────────────────────────  reservation-core (vendor-free)  ──────────────────────────┐
                │  domain · rbac · entitlements · plugin SDK · http · validation · the RLS SQL · withRoute │
                └───────┬─────────────┬──────────────┬───────────────┬───────────────┬──────────────────┘
        IdentityProvider│   Database  │ EmailProvider │ PaymentProvider│ StorageProvider│  Clock / IdGen
   ┌────────────────────┴──┐ ┌────────┴───────┐ ┌─────┴──────┐ ┌──────┴──────┐ ┌──────┴─────┐ ┌──┴───┐
   │ Supabase Auth (ref)   │ │ Supabase (ref) │ │ Resend(ref)│ │ Stripe (ref)│ │ Supabase   │ │ system│
   │ Auth.js · Lucia       │ │ pg/Drizzle/Kysely│ │ SMTP·SES   │ │ GoPay·Comgate│ │ S3 · local │ │ fake  │
   └───────────────────────┘ └────────────────┘ └────────────┘ └─────────────┘ └────────────┘ └───────┘
```

The ports, in brief (full signatures in the code file):

| Port | Responsibility | Reference adapter | Other adapters |
|---|---|---|---|
| `IdentityProvider` | who is the caller; password/OAuth/magic‑link/OTP flows; user provisioning | Supabase Auth | Auth.js (NextAuth), Lucia, custom GoTrue |
| `SessionStore` | persist/refresh the session in cookies | Supabase SSR | Auth.js, iron‑session |
| `Database` | `asUser(id)` (RLS‑scoped), `asAnon()`, `asService()` (bypass), `tx`, `rpc` | Supabase client | postgres.js, node‑postgres, Drizzle, Kysely |
| `AuthzStore` | the few cross‑cutting reads core does itself (profile, memberships, guardianships, plugin activation, tier, provisioning) | over Supabase | over any `Database` |
| `EmailProvider` | `send(message) → ok\|skipped\|error`, never throws | Resend | SMTP/Nodemailer, SES, Postmark, console |
| `PaymentProvider` | checkout (subscription + course), refund, `verifyWebhook → neutral event` | Stripe | GoPay, Comgate, Adyen, mock |
| `StorageProvider` | put / signed URL / remove (optional) | Supabase Storage | S3, local FS |
| `Clock` / `IdGen` | deterministic time & ids for tests | system | fake/seeded |

### 4.1 Why `Database` is narrow (not an ORM)

Tempting mistake: abstract *every table* behind a repository. That re‑implements an ORM badly and loses the
ergonomics of the app's chosen data layer. Instead the `Database` port abstracts only **(a) identity‑scoped vs
service‑role execution** and **(b) transactions/RPC**. Core itself touches the DB through a tiny `AuthzStore`
(profile, memberships, guardianships, plugin activation, tier, `provisionTenant`). **Your app's own domain
queries (courses, sessions, credits) use whatever you like** — the Supabase client, Drizzle, raw SQL — as long
as they run on a `ScopedDb` so RLS sees the actor. Core supplies the schema + RLS + the `current_user_id()`
contract; it does not dictate your query builder.

### 4.2 What stays in core (vendor‑free, the reusable value)

The domain (`domain/credits/*` — the omluvenka engine), `rbac`, `entitlements`, the **Plugin SDK**, `http`
(`jsonOk`/`jsonError`/`HttpError`), `validation`, `i18n` factory, and the **SQL building blocks** (the RLS
recipe, `is_member_of`, the atomic capacity RPC). None of it imports a vendor. This is the part worth
open‑sourcing — the multi‑tenant + RBAC + entitlements + plugin backbone that today every SaaS rebuilds.

## 5. The Next.js axis (bonus decoupling)

`withRoute`, `proxy.ts`, and `cache()` bind to Next.js. For maximum reach, split:

- **`@reservation-core/core`** — framework‑agnostic: takes a Web `Request`, returns a Web `Response`; the
  pipeline (identity → tenant → role → plugin → entitlement → validate) is pure and testable with `fetch`‑style
  objects. `requireClaims` becomes `resolveClaims(req, runtime)` (no React `cache()`; memoize via a per‑request
  context map instead).
- **`@reservation-core/next`** — the binding: `withRoute` for Route Handlers, the `proxy.ts` middleware glue,
  the `cache()` wrapper, cookie helpers via `next/headers`.

This lets the same core power a Hono, Remix, or Express app. It also makes the core's tests run without Next.

## 6. Open‑source plan

### 6.1 Two layers, both potentially OSS

There's a *generic* layer and a *domain* layer; separating them widens the audience:

1. **`tenantkit` (working name) — the generic multi‑tenant SaaS backbone.** Ports, `withRoute`, tenancy, RBAC,
   entitlements, the plugin SDK, the RLS recipe. Appeals to **anyone** building multi‑tenant SaaS on
   Next.js + Postgres — the broadest audience (this is what people pay SaaS‑boilerplate vendors for).
2. **`reservation-core` — the reservation/booking domain on top.** Courses/sessions/capacity, the
   attendance + **omluvenka credit engine**, the booking‑calendar primitives. The flagship example of the
   generic layer, and useful to anyone building a booking product.

We can ship layer 1 as the headline OSS package and layer 2 as a first‑party domain package + example app.
(If that's too much surface to start, keep one repo and one `reservation-core` package with clear internal
boundaries, and split later.)

### 6.2 License & what's public vs private

- **MIT** for the core, the first‑party adapters, and the generic plugins. MIT is compatible with the SDKs the
  adapters wrap (Supabase, Stripe, Resend are MIT/Apache).
- **Public:** `core`, `adapter-*`, generic `plugins/*`, `examples/*` (a minimal demo app), docs.
- **Private / not published:** the **Termínář product app**, the **"Delfínek" brand tokens** (doc 11),
  customer data, and any tenant‑specific config. Our edge is the *product*, not the plumbing — open plumbing is
  low‑risk, high‑reputation.

### 6.3 Repo & consumption

- A dedicated **public monorepo** (`packages/core`, `packages/next`, `packages/adapter-supabase`,
  `packages/adapter-postgres`, `packages/email-*`, `packages/payments-*`, `plugins/*`, `examples/*`), pnpm +
  Turborepo, published to npm under an `@reservation-core/*` (or `@tenantkit/*`) scope, **SemVer**.
- The private product monorepo **consumes the published packages** (or a git submodule during incubation).
- **Develop‑in‑public** from early: a `requires Postgres ≥ 14 + RLS` compatibility statement, a CONTRIBUTING
  guide, and an **adapter‑authoring guide** with a **conformance test suite** every adapter must pass.

### 6.4 The conformance suite = the honesty check

Core ships a **port conformance test suite** and an **in‑memory adapter**. Two payoffs: (1) core's own tests
run vendor‑free and fast; (2) "is it *really* decoupled?" stops being a matter of opinion — a new adapter is
"done" when it passes the suite. This is cheaper and more convincing than standing up five real backends.

## 7. Reference adapters & rollout order

> **Built:** the Supabase reference adapter now exists concretely at
> [`packages/adapter-supabase/`](../packages/adapter-supabase/) — `createSupabaseRuntime()` plus `Database`,
> `IdentityProvider`, `SessionStore`, `AuthzStore`, `StorageProvider`, a one‑migration SQL note, and a
> drop‑in README. Building it sharpened two ports (recorded here): `Database` became **request‑scoped**
> (`forRequest(req).{user,anon,service}()`, since Supabase derives identity from the cookie JWT — no
> `SET LOCAL`), and `IdentityProvider.oauthAuthorizeUrl` became **async** (the URL is computed server‑side).
> That's the ports‑and‑adapters loop working as intended: a real adapter makes the abstraction honest. Layer
> boundary, naming, and the public‑repo plan are fixed in [ADR‑0010](adr/0010-two-layer-packaging-and-oss-repos.md).

| Order | Adapter | Why |
|---|---|---|
| 1 | **Supabase** (`Database` + `IdentityProvider` + Storage) — **done**, `packages/adapter-supabase/` | our products use it; the reference. |
| 1 | **Resend** (`EmailProvider`), **Stripe** (`PaymentProvider`) | already designed; formalize the port. |
| 2 | **In‑memory** (all ports) | the conformance/test backend; forces the seams honest. |
| 3 | **pg/Drizzle + Auth.js** (`Database` + `IdentityProvider`) | the "no paid vendor" OSS path — the proof of portability. |
| 4 | **SMTP** email, **GoPay/Comgate** payments | community‑relevant (CZ), low effort once the ports exist. |

**Don't build five adapters up front.** Design the seams now (ports defined, all Supabase access routed
through them, `current_user_id()` in place — done in this revision), ship the **Supabase adapter first**, then
prove the abstraction with the **in‑memory** adapter and **one** no‑vendor adapter. More adapters are a
backlog, not a blocker.

## 8. Honest trade‑offs

- **Abstraction tax.** Indirection through ports is more code and a small cognitive cost. Mitigation: keep
  ports *narrow* (esp. `Database`); don't abstract what doesn't vary.
- **Lowest‑common‑denominator risk** on the **identity** port (magic‑link/OTP/OAuth semantics differ across
  IdPs). Mitigation: model the *operations core needs*, let adapters compose them; Supabase implements them
  natively, Auth.js composes. Accept that some exotic IdP features won't surface through the port.
- **Test matrix growth** — every adapter × the conformance suite. Mitigation: the in‑memory adapter carries
  the bulk; real adapters run in a smaller integration lane.
- **Realtime & Storage** are intentionally *optional* in core (not every adapter provides them); features that
  need them degrade gracefully.

## 9. Impact on the rest of this spec

| Doc | Change |
|---|---|
| [ADR‑0001](adr/0001-stack-nextjs-supabase-resend.md) | Reframed: Supabase/Resend/Stripe are the **reference adapters**; the hard dependency is **Postgres + RLS**. |
| [ADR‑0009](adr/0009-portability-ports-and-adapters.md) | **New** — records this decision. |
| [02 — reservation‑core](02-reservation-core.md) | Package map gains `ports/` + `adapter-*`; `withRoute`/`requireClaims` take a `CoreRuntime` instead of importing `createServerClient`. |
| [03 — data model §7](03-data-model.md) | RLS predicates identify the caller via `core.current_user_id()`, not `auth.uid()`. |
| [`src/db/index.ts`](../packages/kernel/src/db/index.ts), [`src/ports/index.ts`](../packages/kernel/src/ports/index.ts) | Updated/added in this revision. |

Net: a focused, low‑regret set of changes that turns a Supabase‑shaped framework into a **Postgres‑native,
vendor‑pluggable, MIT‑licensable** one — without weakening the RLS security model that makes it worth using.
