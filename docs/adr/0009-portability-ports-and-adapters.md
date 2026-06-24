# ADR-0009 — Portability: ports & adapters, Postgres as the only hard dependency

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** architecture, open-source, portability

## Context

[ADR-0001](0001-stack-nextjs-supabase-resend.md) chose Supabase + Resend + Stripe and the mockup code wired
them in directly: `requireClaims()` calls `supabase.auth.getUser()`, the RLS helpers in `src/db/index.ts`
identify the caller via Supabase's `auth.uid()`, and `email/send.ts` imports `resend`. We now want
`reservation-core` to be **open-sourced (MIT, public repo)** and usable by anyone with *any* Postgres, *any*
email service, and *any* payment provider — broadening its audience well beyond our own products.

The reframe that makes this tractable: **"Supabase" is not one thing — it is five** (Postgres, GoTrue auth,
PostgREST, Storage, Realtime). "Decouple from Supabase" is therefore five separate decisions, and only one of
them is load-bearing: **where tenant isolation lives.** Ours lives in **Row-Level Security**, which is a
**Postgres feature, not a Supabase one.**

## Decision

Adopt a **ports & adapters** architecture with exactly **one hard dependency: Postgres ≥ 14 with RLS.**
Everything else is a port with swappable adapters:

- **Identity** (`IdentityProvider`/`SessionStore`), **Database** (`Database`/`AuthzStore`), **Email**
  (`EmailProvider`), **Payments** (`PaymentProvider`), **Storage** (`StorageProvider`), plus `Clock`/`IdGen`
  for deterministic tests. Core depends only on these interfaces (`src/ports/index.ts`).
- RLS stays the security boundary, but the caller is identified by a core-owned
  **`core.current_user_id()`** that reads either the PostgREST JWT-claims GUC **or** an `app.user_id` GUC a
  direct-driver adapter sets with `SET LOCAL`. The identical policies run on Supabase, Neon, RDS, or a laptop.
- **Supabase / Resend / Stripe become the *reference adapters*** in separate packages, not core imports.
- A second axis: core speaks Web `Request`/`Response`; the Next.js binding (`@reservation-core/next`) is itself
  an adapter, leaving Hono/Remix/Express possible.

## Consequences

**Positive:** OSS-friendly ("bring your own auth/email/payments"); no vendor lock-in; testable against
in-memory adapters; honest, defensible boundary (Postgres+RLS) instead of lowest-common-denominator mush.
**Negative / costs:** an abstraction layer to maintain; each adapter needs a conformance test pass; the
identity port is the hard one (magic-link/OTP semantics differ across IdPs). **Follow-ups:** ship the Supabase
adapter first; prove the seam with an in-memory adapter (core's own tests) and one no-vendor adapter
(pg + Auth.js); see [14 — Portability & providers](../14-portability-and-providers.md).

## Alternatives considered

- **Stay Supabase-coupled (status quo).** Simplest, fastest for *our* products — but un-open-sourceable as a
  reusable framework and locks adopters to a paid service. Rejected given the OSS goal.
- **Abstract over "any database" (incl. MySQL/Mongo).** Would gut the RLS-in-the-database security model and
  force app-layer-only scoping (one forgotten `WHERE` = cross-tenant leak). Rejected: Postgres+RLS *is* the
  product's spine and selling point.
- **App-layer tenant scoping via a repository, no RLS.** More portable but trades away defense-in-depth.
  Offered as an *optional* mode, not the default.
