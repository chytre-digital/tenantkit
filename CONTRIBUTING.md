# Contributing to tenantkit

Thanks for your interest! `tenantkit` is a multi‑tenant SaaS backbone for **Next.js + Postgres**. This guide
covers the dev loop, the architecture rules, and — importantly — **how to author an adapter**.

## Dev setup

```bash
pnpm install
pnpm build        # turbo, builds all packages
pnpm test         # vitest across packages
pnpm typecheck
pnpm conformance  # the port conformance suite against the in-memory runtime
```

Requires **Node ≥ 20**, **pnpm**, and (for integration tests) a local **Postgres ≥ 14 with RLS**.

## Architecture rules (enforced)

- **Postgres + RLS is the only hard dependency.** Don't add a query path that bypasses RLS outside the
  `service` scope. Tenant isolation lives in the database (`core.is_member_of()` / `core.can_act_for_participant()`).
- **The kernel is vendor‑free.** `@tenantkit/kernel` may not import a vendor SDK — only the **ports** in
  `packages/kernel/src/ports`. Vendors are adapter packages.
- **Layer boundaries:** `domain → {domain, shared}` · `infrastructure → {infra, domain, shared}` ·
  `application → {…, infra, domain, shared}` · `server → {…}` · `presentation` never imports infra directly.
- **Strict TypeScript** (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).

## Authoring an adapter

An adapter implements one or more ports (`Database`, `IdentityProvider`, `SessionStore`, `AuthzStore`,
`EmailProvider`, `PaymentProvider`, `StorageProvider`). The bar is objective:

> **An adapter is "done" when it passes the conformance suite** (`@tenantkit/testing`):
> ```ts
> import { runAllConformance } from '@tenantkit/testing'
> describe('my-adapter', () => runAllConformance(() => makeMyHarness()))
> ```

Use `@tenantkit/adapter-supabase` as the reference. Postgres adapters resolve identity via a `SET LOCAL
app.user_id` GUC so `core.current_user_id()` works on any Postgres (see `docs/14` §3.1).

## Releases

We use **Changesets**. With your PR, run `pnpm changeset`, describe the change, and pick the bump. Maintainers
publish via `pnpm release`. Packages follow **SemVer**; `@tenantkit/*` are version‑linked.

## Code of conduct

Be kind. Assume good intent. PRs welcome — especially adapters (Drizzle, Auth.js, SMTP, GoPay/Comgate) and
plugins.
