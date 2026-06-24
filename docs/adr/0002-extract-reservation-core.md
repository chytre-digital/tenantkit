# ADR-0002 — Extract `reservation-core`

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** architecture, reuse, framework

## Context

Reading `main-panel` and `admin-console` side by side revealed that they **independently re-implement the
same building blocks with the same names**: the four Supabase client factories
(`server`/`client`/`admin`/`proxy` `updateSession`); `withAuthRoute({ getXId, requireX, minRole,
entitlements }, …)`; `requireClaims()` → an `AuthContext` of memberships; an active-tenant **cookie** +
`switch-tenant` route; `roles.ts` (`AppRole`, `roleAtLeast`); the HTTP stack (`jsonOk`/`jsonError`,
`HttpError` + factories, Postgres-error → HTTP mapping); the Zod validation stack (`parseJson` →
`ParseResult`); the entitlements engine (`TIER_ENTITLEMENTS`, `checkEntitlements`); the Resend layer; and
the next-intl wiring.

The **only** material difference is the *tenant noun* — `instructor`/`studio` vs `restaurant`. Everything
else is accidental duplication that has already **drifted**: a duplicated `jsonOk/jsonError` pair, two
divergent next-intl configs (`cs` vs `en` default), and `admin-console`'s inline RLS membership subquery
that produced an "infinite recursion in policy" incident. Termínář 2 would be a *third* copy. That is
~60 % of the product reinvented for the third time.

## Decision

Extract the shared plumbing into **`reservation-core`**, a product-agnostic framework that knows about
*tenants, members, roles, plans, plugins, routes, and email* — never about courses, sessions, or
omluvenky. Generalize the single real coupling (the tenant noun) via `defineTenancy({ tenantTable,
membershipTable, tenantTerm })`. Termínář 2 is built on it; `main-panel` and `admin-console` are designed
to refactor onto it later. The framework is **headless** (no required UI) and runs TypeScript `strict`.

## Consequences

**Positive:** Deletes thousands of lines of drift; one canonical `withRoute`, one HTTP/error model, one
i18n factory, one RLS membership predicate; a fix to core plumbing benefits every app; new products start
from a small `core.config.ts`.
**Negative / costs:** A package (with versioning, releases, and a stable API) to maintain; up-front
generalization effort; the core must stay genuinely product-agnostic or it leaks one app's assumptions
into all of them.
**Follow-ups:** Package map and `withRoute` signature ([02](../02-reservation-core.md)); monorepo so the
core type-checks against every consumer in one CI run ([ADR-0003](0003-monorepo-and-packaging.md)); the
`is_member_of()` helper ([ADR-0008](0008-rls-is-member-of.md)).

## Alternatives considered

- **Copy-paste per app (status quo).** Zero coordination cost, but guarantees more drift and triple-fixes
  for every bug (the recursion incident is the cautionary tale). Rejected.
- **A thin npm util library only** (helpers, no opinions). Captures the trivial bits but leaves the
  load-bearing patterns (`withRoute`, identity, RLS) duplicated — the actual source of drift. Rejected.
- **Git submodule of shared source.** Sharing without real versioning or per-package boundaries; awkward
  CI and no independent release cadence. Rejected in favor of workspace packages.
