# ADR-0001 — Stack: Next.js 16 + Supabase + Resend

- **Status:** Accepted — *refined by [ADR-0009](0009-portability-ports-and-adapters.md)*
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** architecture, infrastructure, security

> **Refinement (ADR-0009):** Supabase, Resend and Stripe are now the **reference adapters** behind ports, not
> hard dependencies. The one hard dependency is **Postgres + RLS** (a Postgres feature, not a Supabase one).
> Everything below still holds for *our* deployment — we run Supabase — but the framework no longer requires it.
> See [14 — Portability & providers](../14-portability-and-providers.md).

## Context

The legacy `terminar` is a .NET modular monolith — a solid domain reference, but it is the team's *only*
.NET system. Our two other production apps, **NaLekci.cz** (`main-panel`) and **Restaurio**
(`admin-console`), both run **Next.js + Supabase**. Maintaining a third runtime, a second auth model, and a
separate ops/deploy story for Termínář 2 would tax a small team and, crucially, would make it impossible to
share code with those two apps — which independently re-implement the same auth/tenancy/HTTP plumbing
(see [ADR-0002](0002-extract-reservation-core.md)).

We also want **tenant isolation to be a database invariant**, not an app convention. Supabase's Postgres
Row-Level Security gives us a security boundary that holds even if an app-layer check is buggy. Managed
infra (Supabase Cloud + Vercel) removes the operational burden of running databases, auth servers, and
queues ourselves.

## Decision

Build Termínář 2 on **Next.js 16** (App Router, RSC) + **Supabase** (Postgres 15, Auth/GoTrue, RLS,
Storage, Realtime, Edge Functions) + **Resend** for transactional email, with **Stripe** and the SMS
provider arriving as plugins. This is deliberately the stack `main-panel` and `admin-console` already run,
chosen so `reservation-core` can later absorb both. TypeScript runs `strict: true` (the legacy apps run
`strict: false`; the core flips it on).

## Consequences

**Positive:** Shared `reservation-core` becomes possible; one mental model across three apps; RLS is the
real authorization gate; managed infra (Vercel + Supabase Cloud, EU region) means no servers to run;
hiring/onboarding draws on the team's existing skills.
**Negative / costs:** We rewrite the legacy domain rather than porting it; RLS expertise becomes a required
competency; cold-start and RSC mental overhead. *(Vendor coupling to Supabase was the other cost here; it is
addressed by the ports & adapters architecture in [ADR-0009](0009-portability-ports-and-adapters.md) — Supabase
becomes swappable, Postgres+RLS stays.)*
**Follow-ups:** Define the four Supabase client factories and `withRoute` ([02](../02-reservation-core.md));
fence service-role usage with lint; stand up Vitest + Playwright + pgTAP from day one.

## Alternatives considered

- **Keep .NET / port the monolith.** Lowest domain-risk, but strands us on a runtime no other app uses,
  blocks code sharing, and keeps EF change-tracking and JWT-claim classes of bug. Rejected.
- **Node + Prisma + custom auth (e.g. NextAuth/Lucia).** Familiar runtime, but we'd own auth, multi-tenancy
  and RLS-equivalent isolation ourselves, and still diverge from the two reference apps. Rejected — Supabase
  gives auth + RLS + storage as managed primitives.
- **Rails.** Mature and fast to build in, but a fourth ecosystem for the team and no path to share the
  TypeScript core. Rejected.
