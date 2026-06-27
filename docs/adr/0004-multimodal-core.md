# ADR-0004 — Multimodal core

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** architecture, auth, multitenancy

## Context

The brief asks for *"multitenant multimodal s rolema."* Termínář 2 has to serve, on one foundation, very
different callers: a **staff** admin console (role-scoped), a **family** participant portal
(guardian/participant identity), an **anonymous public** enrollment surface, and a cross-tenant **ops**
back-office. These differ along several independent axes at once:

1. **Tenant type** — the tenant noun is app-configurable (`studio` here; `instructor` for NaLekci,
   `restaurant` for Restaurio) via `defineTenancy`.
2. **Identity type** — two authenticated subjects coexist: **staff** (a user with `memberships` in a
   tenant) and **family** (a Guardian/Participant account with `participant_accounts` over participants,
   [ADR-0007](0007-participant-accounts.md)). One account can be both.
3. **Auth method** — password, OAuth, magic link, OTP, and login-less **safe-link** tokens, all first-class.
4. **Surface** — admin console, public, portal, ops.

The legacy system fractured along these lines (three participant token schemes + two portals). The reference
apps only ever handled the staff axis. We do not want a separate codebase, auth stack, or HTTP convention
per surface.

## Decision

Make the core **modal along all four axes with a single endpoint wrapper**. `withRoute(opts, handler)` is
the one way to write a route; an **`audience` option** (`'public' | 'staff' | 'family'`, default `'staff'`)
selects the identity contract, and the same options object expresses `tenantFrom`, `minRole`/`can`,
`plugin`, `entitlements`, `rateLimit`, and Zod `body`/`query`. `requireClaims()` returns *both* the
`memberships` (staff) and `participantAccounts` (family) shapes; the requested `audience` decides which is
required. RLS — the second gate — backs whichever path runs. Surfaces are routed by host/cookie in
`proxy.ts`; defaults are safe (deny).

## Consequences

**Positive:** Portal + admin + public + ops share one foundation, one error model, one validation kit, one
test harness; adding a surface or auth method is configuration, not a new stack; a single account can act as
staff and family without duplicate identities.
**Negative / costs:** `withRoute` is a larger, more carefully-tested abstraction; `RouteCtx` carries both
staff and family fields (some null per call); the audience/permission matrix must be covered by tests so a
public route never silently exposes staff data.
**Follow-ups:** Specify the family `ParticipantContext` and `can_act_for_participant()` RLS
([ADR-0007](0007-participant-accounts.md)); document audience-default and tenant-resolution order;
rate-limit the auth-adjacent public routes.

## Alternatives considered

- **Separate apps + separate auth per surface.** Clear isolation, but multiplies code, auth stacks, and
  drift across portal/admin/public — exactly the legacy three-token mess. Rejected.
- **Staff-only core with a bolt-on portal.** Matches what the reference apps do today, but the
  guardian/participant model and family RLS would live outside the framework and never be reused. Rejected —
  family identity belongs *in* the core.
