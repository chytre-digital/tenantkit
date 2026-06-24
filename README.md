# tenantkit

> A reusable, **multi‑tenant / multi‑modal / role‑based** foundation for reservation‑style SaaS on
> **Next.js + Postgres**. Bring your own auth, email, and payments. Tenant isolation is enforced in the
> database (RLS), not just the app.

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) · `DRAFT v0.1` — design spec + reference mockup, not yet production.

`tenantkit` is the open‑source framework extracted from two real products (NaLekci.cz, Restaurio) that had
independently re‑implemented the same plumbing — auth, tenancy, roles, HTTP/validation, entitlements, email,
i18n, and a plugin runtime. It is split into two layers:

- **Layer 1 — `@tenantkit/*`** — the generic multi‑tenant backbone (this is what most people want).
- **Layer 2 — `@reservation-core/*`** — the reservation domain (courses, sessions, the omluvenka makeup‑credit
  engine) built on the kernel. The reference example.

The companion **product** (Termínář) lives in a separate **private** repo and consumes these packages — see
[ADR‑0010](docs/adr/0010-two-layer-packaging-and-oss-repos.md).

## The one hard dependency

**Postgres ≥ 14 with RLS.** Everything else is a port with swappable adapters. Works on Supabase, Neon, RDS,
Railway, Fly, self‑hosted, or a laptop. *Not* "any database" — RLS in the database is the security model and a
deliberate, proud choice. See [ADR‑0009](docs/adr/0009-portability-ports-and-adapters.md) and
[docs/14](docs/14-portability-and-providers.md).

## Packages

| Package | Layer | What |
|---|---|---|
| `@tenantkit/kernel` | 1 | ports, `withRoute`, tenancy, RBAC, entitlements, plugin SDK, http, validation, i18n, **fields**, the RLS SQL |
| `@tenantkit/next` | 1 | Next.js binding (cookies, session‑refresh middleware) |
| `@tenantkit/adapter-supabase` | 1 | **reference adapter** — Database + Identity + Session + Authz + Storage |
| `@tenantkit/adapter-postgres` · `@tenantkit/adapter-authjs` | 1 | *(planned)* the no‑vendor path |
| `@tenantkit/email-resend` · `@tenantkit/payments-stripe` | 1 | Email / Payment provider adapters |
| `@tenantkit/testing` | 1 | in‑memory runtime + the **port conformance suite** |
| `@reservation-core/domain` | 2 | courses/sessions/capacity + the omluvenka credit engine |
| `plugins/*` | — | `sms`, `payments`, `booking-calendar`, `ratings` (per‑tenant, entitlement‑gated) |

## Use it (≈12 lines)

```ts
import { cookies } from 'next/headers'
import { createSupabaseRuntime } from '@tenantkit/adapter-supabase'
import { createResendEmail } from '@tenantkit/email-resend'

export const runtime = createSupabaseRuntime({
  email: createResendEmail({ from: 'Acme <no-reply@acme.com>' }),
  cookies: async () => { const s = await cookies(); return { getAll: () => s.getAll(), setAll: (cs) => cs.forEach(c => s.set(c.name, c.value, c.options)) } },
})
// then: export const POST = withRoute({ runtime, audience: 'staff', minRole: 'coach', body: Schema }, handler)
```

A runnable skeleton is in [`examples/minimal`](examples/minimal). The Supabase adapter README is the drop‑in
guide: [`packages/adapter-supabase`](packages/adapter-supabase/README.md).

## Documentation

The full design spec lives in [`docs/`](docs/). Start at [`docs/00-overview.md`](docs/00-overview.md).

| Doc | |
|---|---|
| [02 — the framework](docs/02-reservation-core.md) ★ | packages, `withRoute`, the Plugin SDK |
| [03 — data model](docs/03-data-model.md) | schema, RLS, multi‑tenancy |
| [08 — attendance & omluvenky](docs/08-attendance-and-omluvenky.md) ★ | the makeup‑credit engine |
| [14 — portability & providers](docs/14-portability-and-providers.md) ★ | ports & adapters, BYO everything |
| [15 — configurable fields](docs/15-configurable-fields-and-settings.md) ★ | per‑tenant participant forms |
| [docs/adr/](docs/adr/) | the decisions and their *why* |

Full index in [`docs/00-overview.md`](docs/00-overview.md) (00–15 + ADRs).

## Develop

```bash
pnpm install
pnpm build           # turbo
pnpm test            # vitest across packages
pnpm conformance     # run the port conformance suite against the in-memory runtime
pnpm changeset       # propose a release
```

Requires **Node ≥ 20** + **pnpm**. See [CONTRIBUTING.md](CONTRIBUTING.md) — including how to author an adapter
(it's "done" when it passes the conformance suite). **MIT** licensed.
