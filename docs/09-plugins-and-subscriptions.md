# 09 — Plugins & subscriptions

> The extension model and the money behind it. A **plugin** is an optional, per‑tenant feature module gated by
> the tenant's **subscription tier**; the `payments` plugin is itself what keeps that tier fresh. This document
> is the authority on the plugin lifecycle, the domain‑event bus, the Termínář tier matrix, and the two
> first‑class plugins (`payments`, `sms`). The SDK contract is introduced in [02 §12](02-reservation-core.md);
> entitlements in [02 §10](02-reservation-core.md); the plugin tables in [03 §3](03-data-model.md) and the
> plugin schemas in [03 §9](03-data-model.md).

## 1. Recap — the Plugin SDK contract

A plugin is declared once with `definePlugin` (the spec from [02 §12](02-reservation-core.md)). It touches the
system **only** through five documented **seams**; nothing else is in scope, and that constraint is the whole
point — the core stays decoupled and a plugin can never destabilize it.

```ts
// @reservation-core/plugins
definePlugin(spec: PluginSpec): Plugin

interface PluginSpec {
  id: PluginId                              // 'payments' | 'sms' | 'booking-calendar' | 'ratings'
  name: LocalizedString                     // { cs, en } — shown in the admin "Pluginy" grid
  requiresTier?: Tier                       // entitlement gate, e.g. payments → 'studio'
  dbSchema?: string                         // owns a Postgres schema; NEVER core/public tables
  routes?: PluginRouteModule                // mounted under /api/plugins/<id>/*
  events?: Partial<Record<CoreEvent, EventHandler>>   // subscribe to domain events on core.outbox
  uiSlots?: Partial<Record<UiSlot, ReactComponent>>   // inject into named admin/portal slots
  settingsSchema?: ZodSchema               // per-tenant config → auto-rendered settings form
  onEnable?(ctx: PluginLifecycleCtx): Promise<void>   // provision per-tenant resources
  onDisable?(ctx: PluginLifecycleCtx): Promise<void>  // tear down / suspend
}
```

| Seam | Code term | What it is | Hard rule |
|---|---|---|---|
| **DB schema** | `dbSchema` | A dedicated Postgres schema (`payments.*`, `sms.*`). Migrations ship with the plugin package. | May **reference** core/app rows by id; may **never** `ALTER`/write `core.*` or `public.*` except via published application calls. |
| **Routes** | `routes` | Route handlers mounted at `/api/plugins/‹id›/…`. | Each is pre‑wrapped to assert the plugin is enabled **and** entitled before the handler runs. |
| **Events** | `events` | Handlers subscribed to core domain events (`enrollment.created`, `attendance.excused`, `session.reminder_due`, …) delivered from `core.outbox`. | Read‑only on core data; side effects stay in the plugin's own schema or in published calls. |
| **UI slots** | `uiSlots` | Components injected into named injection points via `<PluginSlot name=…>` from `@reservation-core/ui-mantine`. | Rendered only when the plugin is enabled for the active tenant. |
| **Settings** | `settingsSchema` | A Zod schema → an auto‑rendered form in admin; values stored per tenant in `core.plugin_settings`. | Secrets (API keys) are **never** stored here — they go to the vault (§5.6, §6.5). |

The headline guarantee, repeated because it is load‑bearing: **a plugin never alters core tables and is fenced
off the service‑role client** (see [01 §4](01-architecture.md) and §7 below). Everything else is a consequence
of the five seams.

## 2. Plugin lifecycle

A plugin moves through five states. The distinction between **registered** (the code exists in the deployment)
and **enabled** (a given tenant has switched it on) is the same split that the legacy system proved with
`TenantPluginActivation`; we make both halves explicit.

```
 register ──▶ tenant enables ──▶ onEnable provisions ──▶ runtime ──▶ onDisable
 (app boot)   (admin toggle,      (per-tenant setup,      (routes+      (suspend; data
              gated by tier)      idempotent)             events+UI    retained)
                                                          live)
```

### 2.1 register (deploy / boot time)

The app lists its plugins in `core.config.ts` ([02 §15](02-reservation-core.md)):

```ts
plugins: [payments, sms, bookingCalendar, ratings],   // order is the build order, §9
```

At boot the **registry** (`@reservation-core/plugins`) validates each spec, indexes its event handlers by
`CoreEvent`, registers its route module under the `/api/plugins/‹id›` namespace, and records its `requiresTier`
into the entitlement map (`plugin:<id>` becomes a feature key — §3.3). Registration is **global and tenant‑less**;
no tenant is touched. A duplicate `id` is a boot‑time error.

```ts
// @reservation-core/plugins
interface PluginRegistry {
  get(id: PluginId): Plugin | undefined
  all(): Plugin[]
  handlersFor(event: CoreEvent): Array<{ pluginId: PluginId; handler: EventHandler }>
  routeFor(id: PluginId): PluginRouteModule | undefined
}
```

### 2.2 tenant enables (admin toggle)

In the admin console's *Pluginy* grid, an owner toggles a plugin on. The route is itself entitlement‑gated:

```
POST /api/plugins/:id/enable      (withRoute: staff, minRole 'owner', entitlements:{ features:['plugin:<id>'] })
```

The handler `enablePlugin(tenantId, pluginId)`:
1. Re‑checks `checkEntitlements({ tier, features:['plugin:<id>'] })` → `403 UPGRADE_REQUIRED` if the tenant's
   tier does not own the plugin. **You cannot enable a plugin your plan doesn't include.**
2. Upserts `core.plugin_activations(tenant_id, plugin_id, is_enabled=true, enabled_at=now())`.
3. Runs `onEnable` (next).
4. Writes a `core.audit_log` row (`action='plugin.enabled'`).

### 2.3 onEnable provisions

`onEnable(ctx)` provisions whatever per‑tenant resources the plugin needs, **idempotently** (enabling twice is a
no‑op). `ctx: PluginLifecycleCtx` carries `{ tenantId, admin, settings, vault }` — `admin` is a **schema‑scoped**
service‑role client that can write only the plugin's own schema (§7).

- `payments.onEnable` → ensure a Stripe **Customer** for the tenant (for billing) and seed default
  `plugin_settings` (currency `CZK`, no Connect account yet). It does **not** create a subscription — the
  tenant subscribes via checkout (§5.2).
- `sms.onEnable` → seed the default `sms.templates` rows (one per `(key, locale)`) from the package's bundled
  template pack, so a freshly enabled tenant already has Czech + English reminder copy.

### 2.4 runtime

Once enabled, all five seams are live for that tenant: its routes accept requests, its event handlers receive
matching `core.outbox` events, its UI slots render, and its settings form is editable. Every entry point still
calls the **guard** (§4) on each request — enabling is a stored fact, not a cached capability, so a downgrade
takes effect immediately.

### 2.5 onDisable

```
POST /api/plugins/:id/disable     (withRoute: staff, minRole 'owner')
```

`disablePlugin` sets `is_enabled=false, disabled_at=now()` and runs `onDisable(ctx)`. **Disabling suspends, it
never destroys**: data in the plugin's schema is retained (a studio that re‑subscribes keeps its order history).
`onDisable` typically just pauses outbound effects (e.g. `payments` stops creating new course checkouts but
leaves `payments.orders` intact; an in‑flight Stripe subscription for *tenant billing* is handled separately via
the portal/webhooks, because losing the plan is what disabled it in the first place — see §3.4).

> **Downgrade vs. disable.** A tenant *disables* a plugin deliberately (toggle). A tenant is *downgraded* when a
> Stripe webhook lowers `tenants.tier` below `requiresTier`; the plugin then fails the guard at request time
> (the activation row may still say `is_enabled=true`, but the entitlement half now fails — both must pass).
> Re‑upgrading restores access without re‑provisioning.

## 3. Subscriptions & entitlements — the tier model

### 3.1 "Plugins are entitlements"

The core models a plan as a **tier** ([02 §10](02-reservation-core.md)): a map of feature keys to a boolean or a
numeric limit. The strategic move — proven in `main-panel` — is that **a plugin is just another feature key**:
`plugin:payments`, `plugin:sms`. A tier therefore *owns* a set of plugins, and "can this tenant use SMS?" is the
same question as "does this tier grant `plugin:sms`?". There is no second gating mechanism to keep in sync.

### 3.2 The three Termínář tiers

Termínář ships three tiers. `free` is the always‑available baseline (every new studio starts here);
`studio` is the paid workhorse; `pro` adds the heavier plugins and white‑label.

```ts
// apps/terminar/src/domain/entitlements/tiers.ts
export type Tier = 'free' | 'studio' | 'pro'

export const TIER_ENTITLEMENTS: Record<Tier, TierEntitlements> = { free, studio, pro }
```

| Feature key | CZ (UI) | `free` | `studio` | `pro` |
|---|---|---|---|---|
| `maxCourses` | Počet kurzů | 3 | 50 | `unlimited` |
| `maxStaff` | Počet členů týmu | 1 | 10 | `unlimited` |
| `maxParticipants` | Počet účastníků | 30 | 1 000 | `unlimited` |
| `customDomain` | Vlastní doména | ✗ | ✗ | ✔ |
| `whiteLabelBranding` | White‑label vzhled | ✗ | partial¹ | ✔ |
| `plugin:payments` | Platby (Stripe) | ✗ | ✔ | ✔ |
| `plugin:sms` | SMS notifikace | ✗ | ✗ | ✔ |
| `plugin:booking-calendar` | Rezervační kalendář 1:1 | ✗ | ✗ | ✔ |
| `plugin:ratings` | Hodnocení kurzů | ✗ | ✔ | ✔ |
| `omluvenkyAdvancedWindows` | Platnostní okna (pokročilé) | ✗ | ✔ | ✔ |
| `exports` | Exporty (CSV/XLSX) | ✗ | ✔ | ✔ |
| `weeklyDigest` | Týdenní souhrn e‑mailem | ✗ | ✔ | ✔ |
| `apiAccess` | API přístup | ✗ | ✗ | ✔ |

¹ `studio` may set logo + colors; `pro` additionally controls `from‑name`/`reply‑to` and removes the
"Powered by Termínář" footer. Numeric `unlimited` is the sentinel from `getEntitlements`.

The two gating shapes from [02 §10](02-reservation-core.md) both read this map:

```ts
// boolean / numeric limit checks (route-time)
checkEntitlements({ tier, features: ['exports'] })                 // throws FEATURE_NOT_AVAILABLE
checkEntitlements({ tier, minTier: 'studio' })                     // throws UPGRADE_REQUIRED
// numeric-limit enforcement (use-case time)
assertWithinLimit('maxCourses', currentCount, tier)               // throws LIMIT_REACHED (422)
```

`omluvenkyAdvancedWindows` is the entitlement that gates the `windows` expiry mode in
[08 §5](08-attendance-and-omluvenky.md): on `free`, the course editor's *Platnostní okna* radio is disabled and
the API rejects `expiry.mode === 'windows'` with `FEATURE_NOT_AVAILABLE`.

### 3.3 How `tenants.tier` is materialized & kept fresh

`tenants.tier` ([03 §3](03-data-model.md)) is a **materialized** column — a cached projection of the truth that
lives in Stripe. The pattern (generalized from `main-panel`'s materialized‑tier + FDW design):

- **Request time reads the column.** Every `withRoute({ plugin })` / `entitlements` check reads `tenants.tier`
  directly — one indexed column read, no network call. The check **tolerates staleness**: at worst a tenant who
  just upgraded waits seconds for the webhook to land.
- **Money time goes live.** Any flow that *grants paid value or takes money* (creating a course checkout,
  confirming a subscription change in the portal) resolves the tier **live** against Stripe via
  `tierFromSubscription()` rather than trusting the column.
- **The `payments` plugin owns freshness.** Stripe webhooks (§5.4) are the only writer of `tenants.tier`:
  `customer.subscription.created|updated|deleted` → resolve product → tier → `UPDATE core.tenants SET tier=…`.
- **FDW fast path.** Product → tier mapping uses a Postgres **foreign data wrapper** view of the Stripe catalog
  (`payments.stripe_catalog_products`) so the webhook resolves a tier without a round‑trip to Stripe; it falls
  back to the live Stripe API and caches in‑process (`resolveTierFromProductId`).

```ts
// resolution order, mirrored from main-panel's product-to-tier
tier = product.metadata.tier ?? productNameToTier(product.name)   // 'Free'|'Studio'|'Pro' → tier
```

### 3.4 The materialization loop (sequence)

```
Stripe ──(customer.subscription.updated)──▶ POST /api/plugins/payments/webhook
   │  1. verify signature (STRIPE_WEBHOOK_SECRET)            → 400 on bad sig
   │  2. idempotency: insert event id; seen? → 200 no-op
   │  3. resolve product → tier (FDW → live → cache)
   │  4. upsert payments.subscriptions(tenant_id, tier, status, current_period_end)
   │  5. UPDATE core.tenants SET tier = <resolved> WHERE id = tenant_id   ← the materialization
   │  6. audit_log('subscription.tier_changed', before→after)
   ▼
Next request reads tenants.tier — already fresh.
```

A nightly **reconciliation** job (Vercel Cron, [10 §9](10-notifications-and-email.md)) re‑reads each tenant's
live subscription and corrects any drift (a missed webhook), so the column is *eventually* correct even if a
single webhook is lost.

## 4. The guard — `assertPluginEnabled`

Used both by `withRoute({ plugin })` ([02 §4](02-reservation-core.md), pipeline step 6) and inside every plugin
route. It is the single chokepoint that enforces **both halves**:

```ts
// @reservation-core/plugins
assertPluginEnabled(tenantId, pluginId): Promise<void>   // throws unprocessable('PLUGIN_NOT_ENABLED')
// passes only if BOTH:
//   (a) ACTIVATION:   core.plugin_activations row exists with is_enabled = true
//   (b) ENTITLEMENT:  tenants.tier grants feature key `plugin:<id>`  (checkEntitlements)
```

| Outcome | Activation | Entitlement | Result |
|---|---|---|---|
| Enabled & paid | ✔ | ✔ | passes |
| Toggled off | ✗ | ✔ | `422 PLUGIN_NOT_ENABLED` |
| Downgraded plan | ✔ | ✗ | `422 PLUGIN_NOT_ENABLED` (the entitlement half fails) |
| Never set up | ✗ | ✗ | `422 PLUGIN_NOT_ENABLED` |

Distinguishing the two failures matters for UX: the admin grid shows *"Zapnout"* (enable) when only activation is
missing, but *"Upgradovat plán"* (upgrade) when the entitlement is missing. The legacy `plugin_not_enabled` guard
checked activation only; folding the entitlement check into the same guard is what makes "plugins are
entitlements" real at the request boundary.

## 5. Core domain events (`core.outbox`)

Plugins (and the email layer, [10](10-notifications-and-email.md)) react to **domain events** emitted by core
use‑cases onto `core.outbox` ([03 §3](03-data-model.md)). The producer writes the event **in the same database
transaction** as the state change (transactional outbox → no lost events, no phantom events); a dispatcher then
fans each row out to every subscribed handler and to the email/SMS routers, stamping `processed_at`.

```ts
// emitted inside a use-case, same tx as the write
await emit(ctx, 'attendance.excused', { sessionId, participantId, enrollmentId, excuseId })
```

### 5.1 The catalogue

| Event (`event_type`) | Emitted when | Key payload | Subscribed by |
|---|---|---|---|
| `enrollment.created` | An application is approved or staff enrol a participant | `enrollmentId, courseId, participantId, source` | `payments` (mint course order), email |
| `enrollment.cancelled` | An enrollment is cancelled | `enrollmentId, reason` | `payments` (refund eval), email |
| `attendance.recorded` | A session's attendance is saved | `sessionId, marks[]` | (analytics; none required) |
| `attendance.excused` | A participant is marked excused (staff or self) | `sessionId, participantId, excuseId` | credit‑issuance handler, email |
| `credit.issued` | An omluvenka is minted | `creditId, participantId, sourceCourseId, expiresAt` | `sms`, email ("máte novou omluvenku") |
| `credit.redeemed` | A credit is spent into a makeup | `creditId, makeupId, sessionId` | email (makeup confirmation) |
| `credit.expiring_soon` | Scheduler finds a credit near expiry | `creditId, participantId, expiresAt` | `sms`, email |
| `session.reminder_due` | Scheduler finds a session N hours out | `sessionId, startsAt, recipients[]` | `sms` (reminder), email |
| `session.cancelled` | Staff cancel a session | `sessionId, courseId` | `sms`, email (auto‑excuse notice) |
| `application.submitted` | A public application is submitted | `applicationId, courseId, safeLinkToken` | email (received + safe‑link) |
| `application.approved` | Staff approve an application | `applicationId, enrollmentId` | email (confirmation + magic‑link) |
| `application.rejected` | Staff reject an application | `applicationId, reason` | email (rejection) |
| `payment.succeeded` | Stripe confirms a course payment | `orderId, enrollmentId, amountMinor` | core (set `payment_status='paid'`), email (receipt) |
| `payment.refunded` | A course payment is refunded | `orderId, enrollmentId, amountMinor` | core (`payment_status='refunded'`), omluvenka interplay (§5.5), email |

> **Why events, not direct calls.** Credit issuance ([08 §4](08-attendance-and-omluvenky.md)) is already
> decoupled via `attendance.excused`; the same bus lets `payments` and `sms` and email react **without core
> knowing they exist**. Adding a plugin adds subscribers; it never edits a core use‑case.

### 5.2 — The payments plugin (Stripe): two concerns

The `payments` plugin does **two structurally different jobs**. Conflating them is the classic Stripe‑integration
mistake; we keep them in separate tables and separate Stripe object families.

| Concern | Who pays | What it drives | Stripe objects | Tables |
|---|---|---|---|---|
| **(1) Tenant billing** | the **studio** | `tenants.tier` (the plan) | Customer + **Subscription** + Price/Product | `payments.subscriptions` |
| **(2) Course payments** | the **family** | `enrollments.payment_status` | Checkout Session + PaymentIntent (+ Connect) | `payments.orders`, `payments.payments` |

### 5.2.1 Tenant billing

The studio subscribes to a Termínář plan. This is the loop that materializes the tier (§3.3–3.4).

```
GET  /api/plugins/payments/billing/checkout   → Stripe Checkout (mode:'subscription') for plan studio|pro
GET  /api/plugins/payments/billing/portal     → Stripe Billing Portal (upgrade/downgrade/cancel/card)
POST /api/plugins/payments/webhook            → the event switch (§5.4) — updates tenants.tier
```

```sql
payments.subscriptions(
  id, tenant_id, stripe_customer_id, stripe_subscription_id, stripe_product_id,
  tier, status,                              -- active | trialing | past_due | canceled
  current_period_start, current_period_end, cancel_at_period_end, trial_end,
  created_at, updated_at,
  unique (tenant_id)                          -- one billing subscription per tenant
)
```

When `status` goes `past_due`/`canceled`, the webhook downgrades `tenants.tier` (often to `free`); plugins that
needed the lost tier then fail the guard (§4) at the next request — graceful, automatic loss of access without a
destructive teardown.

### 5.2.2 Course payments

When a family is charged a course fee, a **Checkout Session** is created and an order tracks it. The trigger is
the `enrollment.created` event (§5.1) when the course has a price configured in settings (§5.6).

```
POST /api/plugins/payments/orders/:enrollmentId/checkout   (withRoute: family, plugin:'payments')
   → creates payments.orders(status='pending') + Stripe Checkout (mode:'payment')
   → returns the hosted checkout URL
```

```sql
payments.orders(
  id, tenant_id, enrollment_id, amount_minor, currency,
  kind,                                       -- full | deposit
  status,                                     -- pending | paid | refunded | partially_refunded | canceled
  stripe_checkout_id, stripe_payment_intent,
  created_at, updated_at
)
payments.payments(
  id, order_id, stripe_payment_intent, amount_minor, status, paid_at
)
```

On `checkout.session.completed` → `payment.succeeded` (§5.1): the plugin writes `payments.payments(status='paid')`
and calls the **published** application function `setEnrollmentPaymentStatus(enrollmentId,'paid')` — it does
**not** write `public.enrollments` directly ([03 §9](03-data-model.md)). The enum is
`none | unpaid | paid | waived | refunded` ([03 §5](03-data-model.md)).

### 5.3 Stripe Connect (studios receive money directly)

If a studio takes course fees **into its own bank account** (the usual case — Termínář is not the merchant of
record for course fees), the plugin uses **Stripe Connect**. The studio onboards a connected account
(`payments.connect_accounts(tenant_id, stripe_account_id, charges_enabled, payouts_enabled)`); course Checkout
Sessions are created **on the connected account** with an optional `application_fee_amount` (the platform fee,
configurable per tier — cf. `platformFeePercent` in the reference app). Tenant *billing* (concern 1) always
charges the platform account; only *course payments* (concern 2) route through Connect.

### 5.4 Webhook handling

One endpoint, three invariants — the same robustness the legacy email path lacked:

```ts
// app/api/plugins/payments/webhook/route.ts  (withRoute: public — Stripe is unauthenticated)
1. SIGNATURE   stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)   → 400 on mismatch
2. IDEMPOTENCY insert event.id into payments.webhook_events; on conflict → 200 (already handled)
3. SWITCH      on event.type:
     'customer.subscription.created' | '.updated' | '.deleted'  → reconcile subscription → tenants.tier
     'checkout.session.completed'                               → mark order paid → emit payment.succeeded
     'charge.refunded' | 'refund.updated'                       → mark refunded → emit payment.refunded
     'invoice.payment_failed'                                   → subscription past_due → maybe downgrade
   default → 200 (ignored, logged)
```

The handler uses `getAdminClient()` ([01 §4](01-architecture.md)) **scoped to `payments.*`** and re‑derives
`tenant_id` from the Stripe customer/metadata — it never trusts a tenant id from the request body. All writes are
idempotent so a Stripe retry is safe.

### 5.5 Refunds ↔ omluvenka interplay

A refund is not just money — it can intersect the credit economy ([08](08-attendance-and-omluvenky.md)):

- **Refund a paid course enrollment** → `payment.refunded` → `payment_status='refunded'`; if `refundPolicy`
  says a refunded enrollment forfeits outstanding omluvenky, the handler cancels that enrollment's **unredeemed**
  credits (audited `attendance`‑style as `refund_forfeit`). **Redeemed** credits are never revoked (the makeup
  already happened) — the same asymmetry as attendance correction in [08 §2](08-attendance-and-omluvenky.md).
- **Cancel a session you charged for** → `session.cancelled`; `refundOnCancellation` (settings) decides whether
  Stripe refunds the proportional fee, while the auto‑excuse still mints credits per
  [08 §9](08-attendance-and-omluvenky.md).

### 5.6 Payments settings (`plugin_settings`)

The `settingsSchema` (auto‑rendered in admin, [02 §12](02-reservation-core.md)). **Stripe secret/restricted keys
live in the vault**, never in `plugin_settings`.

```ts
const PaymentsSettings = z.object({
  currency: z.enum(['CZK','EUR']).default('CZK'),
  pricePerCourse: z.record(z.string().uuid(), z.number().int().nonnegative()).optional(), // courseId → minor units
  defaultCoursePrice: z.number().int().nonnegative().optional(),
  deposit: z.object({ enabled: z.boolean(), amountMinor: z.number().int() }).optional(),
  refundPolicy: z.object({
    refundOnCancellation: z.boolean().default(true),
    forfeitCreditsOnRefund: z.boolean().default(false),
    minCancellationNoticeHours: z.number().int().default(48),
  }),
  connect: z.object({ enabled: z.boolean().default(false), platformFeePercent: z.number().default(0) }),
})
```

## 6. The SMS plugin

`plugin:sms` is `pro`‑tier. It sends transactional SMS for the **same events** that the email layer handles
([10 §6](10-notifications-and-email.md)) but over a different channel, behind a **provider port** so the concrete
gateway (Twilio, SMSbrana) is swappable.

### 6.1 The provider port

```ts
// plugins/sms/src/port.ts  (infrastructure boundary, cf. 01 §3)
interface SmsProvider {
  send(msg: { to: E164; body: string; senderId?: string }): Promise<{ ref: string; costMinor?: number }>
  name: 'twilio' | 'smsbrana'
}
// adapters: TwilioProvider, SmsbranaProvider — selected by settings.provider
```

The application layer depends on `SmsProvider`, never on Twilio directly — so a tenant on SMSbrana and a tenant
on Twilio run identical code (the same lesson the four Supabase factories teach: parameterize the vendor).

### 6.2 Subscriptions

| Event | SMS sent | Timing |
|---|---|---|
| `session.reminder_due` | "Připomínka: lekce zítra v 17:00…" | N hours before a lesson (per‑tenant `reminderHours`, default 24) |
| `credit.issued` | "Máte novou omluvenku, platí do …" | on excuse → credit |
| `credit.expiring_soon` | "Vaše omluvenka brzy propadne…" | scheduler, M days before expiry |
| `application.approved` | "Vaše přihláška byla schválena." | on approval |
| `session.cancelled` | "Lekce dne … byla zrušena." | on staff cancellation |

`session.reminder_due` and `credit.expiring_soon` are produced by the **scheduler**
([10 §9](10-notifications-and-email.md)), not by a user action — the SMS plugin merely subscribes.

### 6.3 Consent, quiet hours, cost

- **Opt‑in / consent** — SMS is sent only to recipients who opted in (`notification_preferences`, channel `sms`,
  [10 §7](10-notifications-and-email.md)); a missing opt‑in **silently skips** the SMS (email still goes, since
  email is the always‑on transactional channel). Consent is GDPR‑relevant and timestamped.
- **Quiet hours** — `settings.quietHours = { start:'21:00', end:'08:00', tz }`. A message that would land in
  quiet hours is **deferred** to the window's end, not dropped (reminders re‑target the next allowed minute, but
  never past the lesson).
- **Cost accounting** — each send records `sms.messages.cost_minor` (returned by the provider); the admin
  *Náklady* panel aggregates monthly spend; an optional per‑tenant monthly cap stops sends past a budget.

### 6.4 Tables & templates

```sql
sms.messages(
  id, tenant_id, to_phone, template, locale, body, status,   -- queued | sent | delivered | failed
  provider, provider_ref, cost_minor, error, sent_at, delivered_at
)
sms.templates(tenant_id, key, locale, body, primary key (tenant_id, key, locale))
```

Templates are **per tenant and localized** (`key × locale`), seeded on `onEnable` (§2.3) and editable in admin.
Body interpolation uses the same `{{var}}` data contract as email; recipient locale resolves exactly as in
[10 §3](10-notifications-and-email.md) (guardian profile → tenant default).

### 6.5 SMS settings

```ts
const SmsSettings = z.object({
  provider: z.enum(['twilio','smsbrana']).default('smsbrana'),
  senderId: z.string().max(11),                            // alphanumeric sender, where the provider allows
  reminderHours: z.number().int().default(24),
  events: z.object({                                        // which events trigger an SMS
    reminder: z.boolean().default(true),
    creditIssued: z.boolean().default(false),
    applicationApproved: z.boolean().default(true),
    sessionCancelled: z.boolean().default(true),
  }),
  quietHours: z.object({ start: z.string(), end: z.string(), tz: z.string() }).optional(),
  monthlyCapMinor: z.number().int().optional(),
})
// provider credentials (TWILIO_AUTH_TOKEN / SMSBRANA_PASSWORD) are read from the Vault, NOT from here.
```

## 7. Two further proofs — `booking-calendar` & `ratings`

Two more first‑party plugins exist mainly to prove the SDK generalizes beyond money and messaging:

- **`booking-calendar`** (`pro`) — a **Calendly‑style 1:1 booking** surface, generalized from the legacy
  marketplace's single‑slot booking. Schema `bookingcal.*` (availability rules, bookable slots, bookings);
  routes under `/api/plugins/booking-calendar/*`; a portal UI slot for "book a 1:1 with the coach"; reuses the
  core **atomic capacity RPC** pattern ([02 §14](02-reservation-core.md)) so a slot can't be double‑booked. It
  does not touch `public.sessions` — its bookings are its own.
- **`ratings`** (`studio`) — **course reviews**. Schema `ratings.*(review: tenant_id, course_id, enrollment_id,
  stars, body, status)`; a portal UI slot offered after a course `completed`; an admin moderation slot; subscribes
  to `enrollment.cancelled` only to invalidate a pending review prompt. Pure read of core rows by id.

Both obey every rule in §1: own schema, namespaced routes, slot‑based UI, settings via Zod, zero writes to
`core.*`/`public.*` outside published calls.

## 8. Shipping a third‑party plugin

The SDK is designed so an outside team can ship a plugin without forking the core.

**Package shape** (mirrors the first‑party layout, [01 §2](01-architecture.md)):

```
plugins/<vendor>-<id>/
├── src/index.ts            # export default definePlugin({...})
├── src/routes/             # PluginRouteModule → mounted at /api/plugins/<id>/*
├── src/events/             # CoreEvent handlers
├── src/ui/                 # slot components (optional)
├── src/settings.ts         # Zod settingsSchema
├── migrations/             # SQL owning ONLY the plugin's schema (<id>.*)
└── messages/<locale>.json  # i18n namespace plugins.<id>.*
```

**Migration ownership** — the plugin's migrations create and evolve **only its own schema**; CI runs them in a
sandbox and **fails the build if any statement targets `core.*`, `public.*`, `auth.*`, or `storage.*`** (a
linted denylist). The plugin schema is created with privileges that physically cannot `ALTER` core tables.

**Review / security boundaries** — a submitted plugin is reviewed against the same fences the runtime enforces:
(a) **service‑role is fenced** — a plugin receives only the schema‑scoped `admin` client in `PluginLifecycleCtx`,
never the global `getAdminClient()` (which the core lint forbids outside `app/api/webhooks/**` & `…/cron/**`,
[01 §4](01-architecture.md)); (b) it reads core/app rows **by id under RLS**, never by privileged join; (c)
secrets go to the vault, not `plugin_settings`; (d) its routes are auto‑wrapped with `assertPluginEnabled`, so an
un‑entitled tenant can never reach plugin code. The blast radius of a misbehaving plugin is its own schema.

## 9. Build order

Ship the plugins in dependency order; the platform needs money before it needs reminders.

1. **`payments` first** — it is the only plugin that **writes `tenants.tier`**, so until it exists the tier model
   is theoretical and every paid tier is un‑sellable. Build tenant **billing** (concern 1, §5.2.1) before course
   **payments** (concern 2, §5.2.2): billing unlocks the tiers that gate everything else.
2. **`sms` second** — it depends on the scheduler ([10 §9](10-notifications-and-email.md)) and the
   `notification_preferences` model ([10 §7](10-notifications-and-email.md)) already existing, and it is a `pro`
   add‑on, so it follows naturally once `payments` can sell `pro`.
3. **`ratings`, then `booking-calendar`** — pure proofs, no ordering constraints between them.

Everything here builds on the core seams from [02](02-reservation-core.md); the email side of the same events is
[10 — Notifications & email](10-notifications-and-email.md).
