# ADR-0003 — Monorepo & packaging

- **Status:** Accepted — *package naming refined by [ADR-0010](0010-two-layer-packaging-and-oss-repos.md)*
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** architecture, tooling, packaging

> **Refinement (ADR-0010):** the single `@reservation-core/*` scope described below is superseded by the
> **two-layer** split — `@tenantkit/*` (generic kernel + adapters + testing) and `@reservation-core/*` (the
> reservation domain). The monorepo + Turborepo decision here still stands; only the package names/scopes changed.

## Context

`reservation-core` ([ADR-0002](0002-extract-reservation-core.md)) is consumed by an app (Termínář 2, later
NaLekci and Restaurio) **and** by first-party plugins (payments, sms, booking-calendar, ratings) that ship
their own DB schemas. The core is a fast-moving API: a change to `withRoute`, the `RouteCtx` shape, or the
permission catalogue must be type-checked against *every* consumer, or we re-create the very drift the core
exists to kill. We also need the core to be **headless** — the server framework must never drag React (and
Mantine) into a consumer that only wants route plumbing.

The reference apps already enforce a DDD layer graph with `eslint-plugin-boundaries`; we want that same
boundary enforcement to apply *inside* the core and inside each app, in one toolchain.

## Decision

Use a **pnpm workspace + Turborepo monorepo**. The core is published as **scoped workspace packages** so
apps import only what they need:

- `@reservation-core/server` (server-only: `withRoute`, http, validation, supabase clients, auth, tenancy,
  rbac, entitlements, email, plugin runtime), `@reservation-core/domain` (pure, depends on nothing),
  `@reservation-core/i18n`, `@reservation-core/db`, `@reservation-core/plugins`, plus `reservation-config`
  and `reservation-testing`.
- An **optional** `@reservation-core/ui-mantine` carries the design system; the headless core never depends
  on React.
- `plugins/*` are packages (each its own schema + migrations); `apps/*` (`terminar`, future `nalekci`,
  `restaurio`) depend on the core packages.

One CI run type-checks the whole graph; Turborepo caches and orders builds/tests.

## Consequences

**Positive:** Atomic cross-cutting changes (core + plugins + apps) in a single PR, type-safe end to end;
headless boundary enforced by package layering (only `ui-mantine` and apps import React); shared
tsconfig/eslint/vitest presets; fast incremental CI via remote caching.
**Negative / costs:** Monorepo tooling and Turborepo pipeline to learn and maintain; internal versioning
discipline; a larger single repo and a heavier initial `pnpm install`; release/publish story to define if
the core is ever consumed externally.
**Follow-ups:** Wire `eslint-plugin-boundaries` for the layer graph; define the `turbo.json` task graph and
remote cache; document the per-package public API surface.

## Alternatives considered

- **Multirepo + published packages (npm registry).** Clean independent versioning, but every core change
  becomes a publish-then-bump dance across repos, slowing exactly the iteration the core needs while young.
  Revisit once the API is stable. Rejected for now.
- **A single package** (`reservation-core` as one module). Simplest layout, but cannot keep the server
  framework from pulling React into headless consumers, and forces all-or-nothing imports. Rejected — the
  headless guarantee is non-negotiable.
