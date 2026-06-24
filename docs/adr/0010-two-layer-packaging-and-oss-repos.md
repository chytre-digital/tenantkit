# ADR-0010 — Two-layer packaging & open-source repo strategy

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** open-source, packaging, governance

## Context

[ADR-0009](0009-portability-ports-and-adapters.md) made the framework vendor‑pluggable (ports & adapters,
Postgres‑only hard dependency). We then chose to **split into two layers** — a *generic* multi‑tenant SaaS
backbone (broad audience) and the *reservation* domain on top — and to **open‑source under MIT** with public
GitHub repos. This ADR fixes the layer boundary, the provisional names, and the **repo topology**.

## Decision

**Two layers, one public monorepo, granular npm packages, product stays private.**

- **Layer 1 — `@tenantkit/*` (provisional name):** the generic backbone. `kernel` (ports, `withRoute`,
  tenancy, RBAC, entitlements, Plugin SDK, http, validation, i18n, the RLS SQL), `next` (Next.js binding),
  adapters (`adapter-supabase`, `adapter-postgres`, `adapter-authjs`, `email-resend`, `email-smtp`,
  `payments-stripe`), `testing` (in‑memory adapters + conformance suite).
- **Layer 2 — `@reservation-core/*`:** the reservation domain on the kernel — `domain` (courses/sessions/
  capacity + the omluvenka credit engine) and the first‑party `plugins/*` (payments, sms, booking‑calendar,
  ratings).
- **Topology:** **one public monorepo** (pnpm + Turborepo) holding *all* of the above + `examples/`, published
  to npm as separate packages, released with **Changesets** + SemVer. **Not** one repo per package.
- **The product (Termínář / NaLekci / Restaurio) stays in a private repo** that consumes the *published*
  packages (or a workspace link during incubation).
- Names are **provisional** — `@tenantkit/*` is a working scope, trivially renameable before first publish.

## Consequences

**Positive:** atomic cross‑package changes + one CI/test matrix (a `withRoute` change typechecks against every
adapter and example at once); consumers still get granular installs; clean public/private seam keeps customer
code and brand tokens out of the open repo. **Negative / costs:** monorepo release tooling to set up
(Changesets, npm provenance, CI); a name must be chosen before publish; maintaining a public project (issues,
adapter PRs) is real work. **Follow‑ups:** pick the final name + npm org; scaffold the monorepo (see the repo
list in the platform spec); add the conformance suite as the bar for community adapters.

## Alternatives considered

- **One repo per package** (`tenantkit-kernel`, `tenantkit-adapter-supabase`, …). Maximum modularity, but
  brutal coordination for a tightly‑coupled family (cross‑repo PRs, version lockstep, N CI configs). Rejected.
- **Everything (incl. the product) in one repo, open‑sourced.** Simplest, but leaks the product/brand/customer
  concerns into public and couples the OSS release cadence to product releases. Rejected.
- **Single layer (`reservation-core` only).** Narrower audience; the generic backbone is the part most people
  want. Rejected in favor of the two‑layer split (this ADR).
