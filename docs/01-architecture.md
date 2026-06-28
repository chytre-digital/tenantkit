# 01 — Architecture

## 1. Technology stack

Chosen to match what `main-panel` and `admin-console` already run, so `reservation-core` can absorb them later.

| Layer | Choice | Notes |
|---|---|---|
| Runtime/Framework | **Next.js 16** (App Router, RSC) | Middleware file is `proxy.ts` (Next 16 rename). Server Components by default. |
| UI runtime | **React 19.2** | RSC‑first; client components opt in with `'use client'`. |
| Language | **TypeScript 5.9, `strict: true`** | Legacy apps run `strict:false`; the core flips it on (see [ADR‑0002](adr/0002-extract-reservation-core.md)). |
| Backend platform | **Supabase** | Postgres 15 + Auth (GoTrue) + RLS + Storage + Realtime + Edge Functions. |
| DB access | `@supabase/ssr` + `@supabase/supabase-js` | Four client factories (see §4). |
| Email | **Resend** | Transactional, idempotency keys, localized templates. |
| Payments | **Stripe** (via the `payments` plugin) | Subscriptions for tenant billing; Connect/Checkout for course payments. |
| SMS | provider behind the **`sms` plugin** | e.g. Twilio / SMSbrana; abstracted by a port. |
| UI kit | **Mantine 8** via optional `@reservation-core/ui-mantine` | The shared design‑token layer; core itself is headless. |
| i18n | **next‑intl 4** | `[locale]` segment, message catalogues, locale‑aware navigation. |
| Validation | **Zod 4** | One schema per request shape; `parseJson`/`parseQuery` helpers. |
| Client data | **TanStack Query 5** + a shared axios instance | Query keys + invalidation conventions in core. |
| Forms | `@mantine/form` + `mantine-form-zod-resolver` | Same Zod schemas validate client + server. |
| Testing | **Vitest** (unit/integration) + **Playwright** (e2e) | Plus `pgTAP`/SQL tests for RLS. |
| Lint/arch | ESLint 9 flat + `eslint-plugin-boundaries` | Enforces the layer graph (§3). |
| Deploy | **Vercel** (app) + **Supabase Cloud** (data) | Cron via Vercel Cron / Supabase scheduled functions. |

## 2. Monorepo layout

A **pnpm + Turborepo** monorepo. `reservation-core` is a set of versioned workspace packages; each product
is an app that depends on them.

```
reservation-platform/                     # the monorepo (this spec describes its design)
├── packages/
│   ├── reservation-core/                 # ★ headless framework — server, no React required
│   │   ├── auth/         # requireClaims, session, guardian/participant identity
│   │   ├── tenancy/      # tenant resolution, active-tenant cookie, membership
│   │   ├── rbac/         # roles, permission catalogue, roleAtLeast, can()
│   │   ├── http/         # withRoute, respond (jsonOk/jsonError), HttpError, error mapping
│   │   ├── validation/   # parseJson/parseQuery/parseHeaders, Zod helpers
│   │   ├── supabase/     # server/browser/admin/proxy client factories (parameterized env)
│   │   ├── email/        # Resend transport, render(), localized template contract
│   │   ├── entitlements/ # tier→feature map, checkEntitlements, plan gating
│   │   ├── plugins/      # Plugin SDK: registry, definePlugin, guards, runtime
│   │   ├── i18n/         # next-intl routing/request/navigation factory
│   │   └── db/           # SQL building blocks: is_member_of(), set_updated_at(), helpers
│   ├── reservation-ui-mantine/           # optional design system (Mantine theme + tokens + primitives)
│   ├── reservation-config/               # shared tsconfig, eslint, vitest presets
│   └── reservation-testing/              # test helpers: tenant factory, RLS harness, fake Resend
├── plugins/                              # first-party plugins (each its own package + DB schema)
│   ├── payments/        # Stripe: tenant subscriptions + course payments
│   ├── sms/             # SMS reminders/notifications
│   ├── booking-calendar/# Calendly-style 1:1 booking
│   └── ratings/         # course reviews
├── apps/
│   ├── terminar/                         # ★ Termínář 2 (this product)
│   ├── (future) nalekci/                 # main-panel, refactored onto core
│   └── (future) restaurio/               # admin-console, refactored onto core
├── supabase/                             # migrations (core schema + per-plugin schemas), seed, RLS, tests
├── turbo.json, pnpm-workspace.yaml, package.json
```

Why a monorepo: the core, the plugins, and the apps version and test together; a change to `withRoute`
is type‑checked against every consumer in one CI run. See [ADR‑0003](adr/0003-monorepo-and-packaging.md).

## 3. Layered architecture (enforced by lint)

Both reference apps already enforce a DDD layer graph with `eslint-plugin-boundaries`. We standardize it
and apply it inside `reservation-core` and inside each app.

```
            ┌─────────────────────────────────────────────┐
 presentation│ React components, pages, Mantine UI          │  (apps + ui-mantine only)
            └───────────────┬─────────────────────────────┘
                            │ may import ↓ (never infra directly)
            ┌───────────────▼─────────────────────────────┐
 application │ use-cases: enrollParticipant, issueCredit…   │  orchestrates domain + infra
            └───────────────┬─────────────────────────────┘
            ┌───────────────▼─────────────────────────────┐
 server      │ withRoute, route handlers, middleware glue   │  HTTP edge
            └───────────────┬─────────────────────────────┘
            ┌───────────────▼─────────────────────────────┐
 infrastructure│ Supabase clients, Resend, Stripe, SMS port  │  talks to the outside world
            └───────────────┬─────────────────────────────┘
            ┌───────────────▼─────────────────────────────┐
 domain      │ entities, value objects, pure policies        │  no I/O, no framework
            └───────────────┬─────────────────────────────┘
            ┌───────────────▼─────────────────────────────┐
 shared      │ types, errors, zod primitives, utils          │  importable by all
            └─────────────────────────────────────────────┘
```

Allowed import directions (the lint rule): `domain → {domain, shared}`; `infrastructure → {infra, domain,
shared}`; `application → {application, infra, domain, shared}`; `server → {server, application, infra,
domain, shared}`; `presentation → {presentation, application, domain, shared}` (**never infra directly**).

The **omluvenka expiry math, credit issuance rules, capacity checks, and permission logic live in
`domain`** — pure, unit‑testable, no Supabase. Infrastructure persists; application orchestrates; server
exposes. This is the single most important reason the legacy bugs (EF change‑tracking, JWT claim
mismatches) don't recur: the rules don't depend on the persistence mechanism.

## 4. Supabase clients (the four‑factory pattern)

Promoted from `main-panel`/`admin-console` verbatim, with the env‑var name **parameterized** (the legacy
apps hardcode a non‑standard `…PUBLISHABLE_DEFAULT_KEY`).

| Factory | Module | Role | Use |
|---|---|---|---|
| `createServerClient()` | `supabase/server.ts` | user session (RLS as user) | RSC & route handlers reading/writing as the signed‑in user. |
| `createBrowserClient()` | `supabase/client.ts` | user session (browser) | Client components. |
| `createAnonClient()` | `supabase/server.ts` | anon role (RLS, no session) | Public reads (course list, slot availability). |
| `getAdminClient()` | `supabase/admin.ts` | **service role (bypasses RLS)** | Webhooks, cron, provisioning, cross‑tenant ops. Server‑only, singleton. |
| `updateSession(req,res?)` | `supabase/proxy.ts` | refresh | Called by `proxy.ts` middleware on every request to rotate the auth cookie. |

> **Rule:** `getAdminClient()` bypasses RLS, so any code using it must re‑check tenant/role *in code*.
> The lint config forbids importing `admin.ts` outside `application/**/admin/**`, `app/api/webhooks/**`,
> and `app/api/cron/**`.

## 5. Request lifecycle (an authenticated mutation)

```
Browser
  │  POST /api/courses/123/sessions  (cookie: sb-…, active_tenant_id)
  ▼
proxy.ts (middleware)
  │  next-intl locale negotiation (skipped for /api) → updateSession() refreshes auth cookie
  ▼
Route handler = withRoute({ minRole:'coach', tenantFrom:'param', plugin:undefined }, handler)
  │  1. createServerClient()                          (RLS as user)
  │  2. requireClaims()  → AuthContext {userId, memberships[], participantAccounts[]}   (cached per request)
  │  3. resolve tenantId (route param ‖ active_tenant_id cookie) and assert membership   → 403 if not
  │  4. resolve role for that tenant; roleAtLeast(role, minRole)                          → 403 if low
  │  5. (if opts.plugin) assert tenant has plugin enabled & entitled                      → 422 plugin_not_enabled
  │  6. parseJson(req, CreateSessionSchema)                                               → 400 on invalid
  ▼
handler(ctx, body)  →  application/use-case  →  domain policy + infrastructure (Supabase write under RLS)
  │  any throw bubbles to jsonError(): HttpError→status, DomainError→mapped, PostgrestError→PG-code map
  ▼
Response  jsonOk({ session })   |   jsonError(...)  → { error, code, details }
```

RLS is the **second** gate: even if `withRoute` had a bug, the Postgres policy (`is_member_of(tenant)`)
would refuse the write. Belt and suspenders by design.

## 6. Rendering & data strategy

- **Server Components** fetch with `createServerClient()` and render tenant‑scoped data directly; no client
  fetch waterfall for first paint.
- **Client mutations** go through **API routes** + **TanStack Query** (`useMutation` → invalidate keys).
  We do *not* use Next Server Actions for mutations (consistent with both reference apps and easier to test
  + reuse from the portal and public surfaces). Server Actions are allowed only for trivial form posts.
- **Public reads** (course catalogue, slot availability) use `createAnonClient()` and are cacheable.
- **Realtime** (Supabase channels) is optional polish for the attendance screen ("coach B is also marking").

## 7. Multi‑tenant routing & domains

- **Admin console**: `app.terminar.cz`. The active tenant is chosen from the `active_tenant_id` **cookie**
  (validated against the user's memberships), switchable in‑app. No subdomain needed for staff.
- **Public + portal**: `‹slug›.terminar.cz` (wildcard DNS + TLS) **or** path‑based `terminar.cz/t/‹slug›`
  as a fallback. `proxy.ts` extracts the slug from the host/path into a request header the app reads.
- **Custom domains** (e.g. `zapis.delfinek.cz`) are a paid entitlement: a `tenant_domains` table maps host
  → tenant; verified by DNS TXT.

See [04 §Tenant resolution](04-roles-and-permissions.md) and [`reservation-core` §tenancy](02-reservation-core.md).

## 8. Environments & configuration

| Env | App | Supabase | Stripe | Resend |
|---|---|---|---|---|
| `local` | `next dev` | local Supabase (CLI) or a `dev` project | test keys | sandbox / console capture |
| `preview` | Vercel preview per PR | shared `staging` project | test keys | sandbox |
| `production` | Vercel prod | `prod` project | live keys | live domain |

All secrets are env vars, validated at boot by a Zod `env.ts` in core (fail fast on missing config). The
Supabase **service‑role key** is server‑only and never shipped to the client bundle (enforced by lint +
`import 'server-only'`).

## 9. Observability & ops

- **Logging**: structured logs from route handlers (request id, tenant id, user id, outcome). No PII in logs.
- **Errors**: Sentry (or similar) in app + edge; `DomainError` codes are stable and dashboarded.
- **Email/SMS**: Resend webhooks → delivery status table; failures are swallowed from the user path but
  recorded (legacy lesson: a failed email must not break enrollment).
- **Audit**: security‑relevant actions (credit edits, role changes, plugin toggles) write append‑only
  `audit_log` rows (see [03](03-data-model.md)).
- **Backups/PITR**: Supabase point‑in‑time recovery on production.

## 10. Security posture (summary)

- RLS **on every table**; default deny; `anon` granted only explicit public reads.
- Service‑role usage is fenced (lint + directory rules) and always re‑checks authorization.
- Rate‑limiting on auth‑adjacent public endpoints (magic‑link request, OTP, application submit) — a gap in
  legacy we close (see [05](05-auth.md)).
- GDPR: the enrollment form captures consent; a `data-export`/`delete` path per account; PII minimization;
  EU data residency (Supabase EU region, Resend EU).
- Signed, expiring **safe‑link tokens**; single‑use where appropriate.

Continue to **[02 — `reservation-core`](02-reservation-core.md)**, the heart of this spec.
