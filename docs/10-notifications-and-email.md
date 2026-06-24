# 10 — Notifications & email

> Every message Termínář sends a human. The core's **Resend** transactional layer ([02 §11](02-reservation-core.md))
> is the spine; on top of it sit the email catalogue, per‑recipient i18n, per‑tenant branding, delivery tracking,
> a notification‑preferences model, the optional SMS channel (the `sms` plugin, [09 §6](09-plugins-and-subscriptions.md)),
> in‑app notifications, and the scheduler that emits time‑based events. The events these consume are defined in
> [09 §5](09-plugins-and-subscriptions.md); the tables (`core.email_events`, `core.outbox`) in
> [03 §3](03-data-model.md).

## 1. Email transport — Resend

The provider is **Resend** ([01 §1](01-architecture.md)). All mail goes through one contract
([02 §11](02-reservation-core.md)); there is no second path:

```ts
// @tenantkit/kernel/email
sendEmail(input: SendEmailInput): Promise<EmailResult>      // ok | skipped (no key) | error — NEVER throws into the request
interface SendEmailInput {
  to: string | string[]; template: EmailTemplate; locale: Locale
  data: Record<string, unknown>; idempotencyKey?: string; tags?: Record<string,string>
}
defineEmail<TData>(spec): EmailTemplate                     // localized subject + react/html renderer
```

Four behaviors are load‑bearing, each a legacy lesson made structural:

- **Localized** — `defineEmail` renders subject **and** body per `locale`; the legacy "hardcoded English"
  mistake is impossible by construction ([00 §7](00-overview.md)).
- **Idempotent** — `idempotencyKey` is forwarded to Resend, so a retried webhook or scheduler tick can't double‑send.
- **Graceful** — a missing `RESEND_API_KEY` → `skipped`; a provider error → `error` **recorded, never thrown**.
  A failed email must not break enrollment ([01 §9](01-architecture.md), [02 §11](02-reservation-core.md)).
- **Branded** — a per‑tenant `TenantBranding` (logo, from‑name, reply‑to) is resolved at send time from
  `tenants.branding` (§4).

Emails are dispatched by the **outbox consumer** ([09 §5](09-plugins-and-subscriptions.md)): a domain event lands
on `core.outbox`, the email router maps it to a template + audience and calls `sendEmail`. Sending is therefore
**decoupled** from the use‑case that caused it — exactly as credit issuance is in
[08 §4](08-attendance-and-omluvenky.md).

## 2. The transactional email catalogue

Every transactional email Termínář sends. *Safe‑link* = an opaque, single‑purpose login‑less token
([00 §6](00-overview.md), [05](05-auth.md)); *magic‑link* = a Supabase passwordless sign‑in link.

| # | Trigger event | Template | Audience | Locale source | Key data | Safe/magic link |
|---|---|---|---|---|---|---|
| 1 | `application.submitted` | `application.received` | Guardian | guardian email lang → tenant | child name, course, studio | **safe‑link** (track/confirm) |
| 2 | `application.approved` | `application.approved` | Guardian | guardian profile → tenant | course, first session, portal CTA | **magic‑link** (portal sign‑in) |
| 3 | `application.rejected` | `application.rejected` | Guardian | guardian profile → tenant | course, reason, alternatives | — |
| 4 | `enrollment.created` | `enrollment.confirmed` | Guardian | guardian profile → tenant | participant, course, schedule | **magic‑link** |
| 5 | `session.reminder_due` | `session.reminder` | Guardian (per enrolled participant) | guardian profile → tenant | session time, location, coach | safe‑link (self‑excuse) |
| 6 | `attendance.excused` | `excuse.confirmed` | Guardian | guardian profile → tenant | session, **whether a credit was issued** | portal link |
| 7 | `credit.issued` | `credit.issued` | Guardian | guardian profile → tenant | "máte novou omluvenku", expiry, balance | **magic‑link** (book makeup) |
| 8 | `credit.expiring_soon` | `credit.expiring` | Guardian | guardian profile → tenant | credit, expiry date, balance | magic‑link |
| 9 | `credit.redeemed` | `makeup.booked` | Guardian | guardian profile → tenant | makeup session time, location | safe‑link (cancel) |
| 10 | makeup cancelled | `makeup.cancelled` | Guardian | guardian profile → tenant | cancelled session, restored balance | magic‑link |
| 11 | magic‑link request | `auth.magic_link` | Guardian / Staff | requester locale | sign‑in link, expiry | **magic‑link** |
| 12 | OTP request | `auth.otp` | Guardian / Staff | requester locale | 6‑digit code, expiry | — (code only) |
| 13 | staff invite | `staff.invite` | Invited staff | inviter tenant default | studio, role, accept CTA | invite token |
| 14 | password reset | `auth.password_reset` | Staff (or family w/ password) | requester locale | reset link, expiry | reset token |
| 15 | weekly digest *(optional)* | `staff.weekly_digest` | Staff (opted‑in) | staff profile → tenant | new applications, upcoming sessions, credit liability | dashboard link |

> **Legacy bug to avoid (row 6).** The excuse‑confirmation email **must correctly reflect whether a credit was
> issued.** Because issuance is a *policy decision* ([08 §4](08-attendance-and-omluvenky.md): `creditsEnabled`,
> cap reached, …), the email cannot assume "excused ⇒ credit." The `excuse.confirmed` template takes
> `creditIssued: boolean` (+ `expiry?`) **from the issuance outcome**, and renders either *"Získali jste
> omluvenku, platí do …"* or *"Absence byla omluvena."* — never the wrong one. The legacy system sent "you got a
> makeup credit" even when none was minted; this is closed by passing the decision, not re‑deriving it.

Each template's `idempotencyKey` is derived from the event identity (e.g. `excuse.confirmed:<excuseId>`), so a
re‑processed outbox row is a no‑op at Resend.

## 3. i18n of email

Email locale is resolved **per recipient**, not per request (the sender is often a coach or the scheduler, whose
locale is irrelevant to the guardian receiving the mail):

```ts
function resolveEmailLocale(recipient): Locale {
  return recipient.profile?.locale          // 1) the guardian/staff per-user override (core.profiles.locale)
      ?? tenant.default_locale               // 2) the studio default (core.tenants.default_locale)
      ?? 'cs'                                 // 3) system default
}
```

This is the same precedence as the app's locale chain ([02 §13](02-reservation-core.md)) minus the URL segment
(there is no URL in an email). Mechanics:

- **Per‑locale templates** — `defineEmail` holds a subject + body **per locale**; missing a locale falls back to
  the tenant default, then `cs`.
- **Message namespace** — all email copy lives under the `email.*` namespace in the per‑app catalogues
  ([02 §13](02-reservation-core.md)); plugins ship their own (`plugins.payments.email.*`).
- **Render** — bodies are authored with **React Email** (MJML is the alternative) and rendered to HTML; a
  **plain‑text** part is generated alongside for every message (deliverability + accessibility).
- **List‑Unsubscribe** — every non‑essential message carries `List-Unsubscribe` (one‑click, RFC 8058) pointing at
  the preferences page (§7). Strictly transactional mail (auth, receipts) is exempt (§7).

## 4. Branding per tenant

A studio's mail looks like *its* mail. `TenantBranding` is resolved at send time from `core.tenants.branding`
([03 §3](03-data-model.md)) by the `brandResolver` registered in `core.config.ts` ([02 §15](02-reservation-core.md)):

```ts
interface TenantBranding {
  logoUrl?: string
  fromName: string                 // "Plavecká škola Delfínek" → From: ... <no-reply@terminar.cz>
  replyTo?: string                 // routes guardian replies to the studio
  colors?: { brand: string; … }    // header/button accent in the template
  poweredBy: boolean               // "Powered by Termínář" footer — removed on pro (white-label, 09 §3.2)
}
```

What a tenant controls is itself **entitlement‑gated** ([09 §3.2](09-plugins-and-subscriptions.md)): `studio` may
set logo + colors; `pro` additionally sets `from‑name`/`reply‑to` and drops the `poweredBy` footer.

**DKIM / domain setup & deliverability.** The platform sends from a verified `terminar.cz` domain (SPF + **DKIM**
+ DMARC configured in Resend), EU region ([00 §2](00-overview.md), [01 §10](01-architecture.md)). Per‑tenant
custom **sending** domains (e.g. `no-reply@delfinek.cz`) are a `pro`/custom‑domain entitlement
([09 §3.2](09-plugins-and-subscriptions.md), `tenant_domains`, [01 §7](01-architecture.md)): the tenant adds DNS
records, Resend verifies, and the From switches to their domain. Deliverability hygiene: a consistent From,
a working `reply-to`, plain‑text alternative, `List-Unsubscribe`, and low bounce/complaint rates (tracked in §5).

## 5. Delivery tracking

Resend reports delivery asynchronously via webhook → `core.email_events` ([03 §3](03-data-model.md)):

```
Resend ──(email.delivered | .bounced | .complained | .opened)──▶ POST /api/webhooks/resend
   │  verify signing secret → 400 on mismatch
   │  upsert core.email_events(tenant_id, resend_id, to, template, status, at)
   ▼
admin "Doručitelnost" panel reads aggregates; high bounce → alert
```

The failure philosophy ([01 §9](01-architecture.md), [02 §11](02-reservation-core.md)): **failures are swallowed
from the user path but recorded.** A guardian's enrollment succeeds even if the confirmation email bounces; the
bounce becomes a `core.email_events` row, not an exception. Retries: a transient `error` from `sendEmail` is
re‑attempted by the outbox consumer with backoff (the `idempotencyKey` prevents duplicates on the eventual
success); a hard bounce is recorded and **not** retried. `resend_id` ties an `email_events` row back to the
`outbox` event that produced it for end‑to‑end tracing.

## 6. The notification‑preferences model

Beyond strictly‑essential mail, recipients choose **which events reach them on which channel**. Preferences are
per‑account and per‑event:

```sql
core.notification_preferences(
  id, user_id, tenant_id,
  event       text not null,        -- 'session.reminder' | 'credit.issued' | 'credit.expiring' | 'weekly_digest' | …
  channel     notification_channel not null,   -- email | sms | in_app
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (user_id, tenant_id, event, channel)
)
```

- **Who** — both **guardians** (per `(user, tenant)`, since one account may belong to several studios) and
  **staff** (digest, operational alerts). The portal and admin each expose a *Notifikace* settings screen.
- **Default‑on, opt‑out** for non‑essential email; channel `sms` is **default‑off / opt‑in** (consent, §SMS,
  [09 §6.3](09-plugins-and-subscriptions.md)).
- **Transactional vs. marketing (GDPR).** A hard line: **strictly transactional** messages — auth (magic‑link,
  OTP, password reset), payment receipts, application/enrollment outcomes, makeup confirmations — are **not
  suppressible** and carry no marketing unsubscribe (they are service messages the recipient asked for by acting).
  Everything optional — reminders, "credit expiring", the weekly digest — is **preference‑controlled** and
  unsubscribable ([10 §3](10-notifications-and-email.md) `List-Unsubscribe`). Termínář sends **no** marketing mail
  from this system; the distinction exists so a future newsletter can never masquerade as transactional.

The router consults preferences right before dispatch:

```ts
function channelsFor(user, tenant, event): Channel[] {
  const out: Channel[] = []
  if (isTransactional(event) || prefEnabled(user, tenant, event, 'email')) out.push('email')   // email default-on
  if (smsPluginEnabled(tenant) && prefEnabled(user, tenant, event, 'sms')) out.push('sms')      // opt-in + plugin
  if (prefEnabled(user, tenant, event, 'in_app')) out.push('in_app')
  return out
}
```

## 7. SMS notifications (via the `sms` plugin)

SMS is the **same events, a different channel**. The mechanics live in the `sms` plugin
([09 §6](09-plugins-and-subscriptions.md)); this section is the channel‑selection contract from the notification
side.

- **Email is the always‑on transactional channel**; SMS is **additive** and only fires when **(a)** the `sms`
  plugin is enabled+entitled for the tenant (`pro`, [09 §3.2](09-plugins-and-subscriptions.md)) **and** **(b)**
  the recipient opted in (`notification_preferences`, channel `sms`) **and** **(c)** the tenant's per‑event SMS
  toggle is on (`SmsSettings.events`, [09 §6.5](09-plugins-and-subscriptions.md)).
- A missing opt‑in or a disabled plugin **silently skips** the SMS — the email still goes. SMS never *replaces*
  the email; it duplicates the salient ones (reminders, new omluvenka, expiring credit, approval, cancellation).
- **Quiet hours** and **cost caps** are the plugin's concern ([09 §6.3](09-plugins-and-subscriptions.md)); the
  notification router just asks "is `sms` a channel for this event?" and hands the payload to the plugin.

## 8. In‑app notifications (the bell)

The **bell icon** in the Admin mockup is backed by a lightweight table + realtime — distinct from email/SMS
(no deliverability, instant, dismissible):

```sql
core.notifications(
  id, tenant_id, user_id,
  type        text not null,         -- 'application.submitted' | 'payment.succeeded' | 'credit.expiring' | …
  title       text not null,
  body        text,
  link        text,                  -- deep-link into the console/portal
  read_at     timestamptz,
  created_at  timestamptz not null default now()
)
create index on core.notifications(user_id, tenant_id) where read_at is null;   -- unread badge count
```

- **What generates them** — the **same outbox events**: the in‑app router (a third subscriber alongside email and
  SMS) inserts a row when `in_app` is a selected channel (§6). Staff‑facing examples: *nová přihláška*
  (`application.submitted`), *platba přijata* (`payment.succeeded`), *omluvenka brzy propadne*. Guardian‑facing in
  the portal: makeup confirmations, credit issued.
- **Realtime** — the client subscribes to a **Supabase Realtime** channel on `core.notifications` filtered to the
  user; the bell badge updates live without polling ([01 §6](01-architecture.md)). Marking read sets `read_at`.
- Retention: read notifications older than N days are purged by the scheduled cleanup job ([03 §10](03-data-model.md)).

## 9. Scheduling — time‑based notifications

Reminders and "expiring soon" are **not** triggered by a user action — a **scheduled job** scans for due items and
**emits the corresponding domain events** onto `core.outbox`, after which the normal fan‑out (email / SMS / in‑app)
takes over. The job is the *only* producer of these events; it owns no delivery logic.

| Job | Cadence | Scans for | Emits |
|---|---|---|---|
| **Reminder sweep** | every 15 min | sessions whose `starts_at` is within each tenant's `reminderHours` window and not yet reminded | `session.reminder_due` (per enrolled participant's guardian) |
| **Credit‑expiry sweep** | daily | active `credits` whose `expires_at` (or earliest `valid_window` end, [08 §5](08-attendance-and-omluvenky.md)) is within `expiryNoticeDays` | `credit.expiring_soon` |
| **Weekly digest** | weekly | staff opted in to `weekly_digest` | `staff.weekly_digest` (per staff member) |
| **Reconcile & cleanup** | nightly | tier drift ([09 §3.4](09-plugins-and-subscriptions.md)); read in‑app notifications, expired credits, old rejected applications ([03 §10](03-data-model.md)) | — (direct maintenance) |

**Runtime** — **Vercel Cron** routes (`/api/cron/*`, service‑role, RLS‑bypassing and fenced per
[01 §4](01-architecture.md)) or **Supabase scheduled functions** ([01 §1](01-architecture.md)). Each job is
**idempotent**: it stamps what it has emitted (a `reminded_at` on the session / a `notice_sent_at` on the credit),
so a re‑run or overlapping tick never double‑emits — and even if it did, the downstream `idempotencyKey`
([10 §1](10-notifications-and-email.md)) and the SMS dedupe absorb it. Time math respects the tenant's timezone so
"24 hours before" and quiet‑hours ([09 §6.3](09-plugins-and-subscriptions.md)) mean the local thing.

> The clean split, end to end: **the scheduler decides *when*, the event bus decides *who subscribes*, the routers
> decide *which channel*, and the templates decide *what it says*.** No layer reaches across — the same decoupling
> that keeps plugins ([09](09-plugins-and-subscriptions.md)) and credit issuance ([08](08-attendance-and-omluvenky.md))
> testable applies to every notification Termínář sends.
