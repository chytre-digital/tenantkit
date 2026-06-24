# ADR-0006 — Plugins as entitlements

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** architecture, plugins, billing, extensibility

## Context

Termínář 2 must ship optional capabilities — **payments** (Stripe), **sms**, **booking-calendar**,
**ratings** — that not every tenant wants or pays for, without forking the product per customer. The legacy
system proved the *activation* idea (`TenantPluginActivation` + a `plugin_not_enabled` guard) but stopped
there: there was no real SDK, no schema isolation, and no clean extension contract. We also already have an
**entitlements engine** (`TIER_ENTITLEMENTS`, `checkEntitlements`) gating plan features. A plugin a tenant
hasn't *paid* for and a plugin a tenant hasn't *enabled* are two different states that must compose.

A hard constraint from the layered architecture: **plugins must never alter core tables or core code
paths**, or the core stops being safely shared across apps.

## Decision

A **plugin is a per-tenant activation gated by subscription tier**. `plugin:<id>` (e.g. `plugin:payments`)
is a **feature key in the entitlements map**, so a tier "owns" a plugin. The guard
`assertPluginEnabled(tenantId, pluginId)` — used by `withRoute({ plugin })` and inside plugin routes —
passes only if the `plugin_activations` row is enabled **and** the tenant's `tier` entitles `plugin:<id>`;
otherwise `422 PLUGIN_NOT_ENABLED`. Plugins are real SDK modules (`definePlugin(spec)`) that **own their own
Postgres schema** and extend the core through exactly **five documented seams**:

1. **DB schema** (`payments.*`, `sms.*`) — may *reference* core tables by id, never alter them.
2. **Routes** — mounted at `/api/plugins/<id>/*`, pre-guarded.
3. **Events** — subscribe to core domain events on the outbox (`enrollment.created`,
   `attendance.excused`, `session.reminder_due`, …).
4. **UI slots** — inject into named `<PluginSlot>` points.
5. **Settings** — a Zod schema → an auto-rendered per-tenant settings form.

This carries the legacy `TenantPluginActivation` concept forward into a first-class SDK.

## Consequences

**Positive:** Billing and capability compose cleanly (tier entitles, tenant enables); the core stays
decoupled — plugins touch it only through seams; new capabilities ship without forks; schema isolation keeps
plugin migrations independent and removable.
**Negative / costs:** The SDK and its five seams are an API surface to design, document, and keep stable;
the double-gate (entitled *and* enabled) must be explained so support understands a "not enabled" 422; the
event outbox is infrastructure to operate.
**Follow-ups:** Full SDK treatment in [09](../09-plugins-and-subscriptions.md); ship payments + sms as the
proof; define the core event catalogue and outbox delivery semantics.

## Alternatives considered

- **Hardcoded feature flags.** Simple, but couples every optional capability into core code, defeats schema
  isolation, and can't be billed per tier cleanly. Rejected.
- **Fork-per-customer.** Maximum flexibility, unmaintainable at scale — the exact trap a plugin model
  exists to avoid. Rejected.
- **Generic webhooks only.** Good for outbound integration, but can't add DB schema, gated routes, UI, or
  typed settings — too thin to build payments/sms inside the product. Rejected (webhooks remain available
  *within* a plugin).
