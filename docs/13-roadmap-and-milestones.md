# 13 — Roadmap & milestones

> The delivery plan from zero to GA. The sequencing principle is fixed by the whole spec: **build
> `reservation-core` first, prove it with one vertical slice, then layer Termínář's domains on top in
> dependency order, and only at the end refactor the existing apps onto the core.** Phases are relative
> (Phase 0..6 / M0..M6) — **no calendar dates**; each gives goals, deliverables, an exit criterion, and rough
> sequencing. Phase content maps 1:1 to the domain docs ([02](02-reservation-core.md)–[12](12-api-surface.md))
> and to the in/out‑of‑scope list in [00 §2](00-overview.md).

## 1. Sequencing at a glance

```
Phase 0  Foundations ───────────── reservation-core skeleton + 1 vertical slice  (the stack works)
   │
Phase 1  Courses & termínář ─────── courses, sessions, recurrence generator, capacity, configurable fields + Settings
   │
Phase 2  Enrollment ─────────────── public QR funnel, applications, approval, manual enroll, identity, email
   │
Phase 3  Attendance & omluvenky ── attendance → credit → redeem  (THE differentiator; doc 00 story works)
   │
Phase 4  Plugins & subscriptions ── plugin runtime, tiers, payments, sms
   │
Phase 5  Hardening & GA ─────────── design polish, a11y, perf, security, rate limits, GDPR, white‑label, docs
   │
Phase 6  Adopt core elsewhere ──── refactor main-panel (NaLekci) + admin-console (Restaurio) onto core
```

The hard ordering constraints: **Phase 0 gates everything** (no core, no app). Enrollment (2) needs courses (1)
to enrol into. Omluvenky (3) needs attendance, which needs sessions (1) and enrollments (2). `payments` (4)
must precede a sellable `pro`, which gates `sms` and white‑label, so most of Phase 4 precedes the
entitlement‑gated parts of Phase 5. Phase 6 needs a stable, versioned core (post‑GA) so the two existing apps
adopt a moving target only once.

## 2. Phase 0 — Foundations

**Goal.** Stand up `reservation-core` as real packages and **prove the entire stack end‑to‑end with one trivial
vertical slice**, so every later phase is "add a domain", never "discover the plumbing".

**Deliverables**

| Area | Deliverable | Ref |
|---|---|---|
| Monorepo | pnpm + Turborepo; `packages/kernel/*`, `reservation-ui-mantine`, `reservation-config`, `reservation-testing`; `apps/terminar`; `eslint-plugin-boundaries` layer graph. | [01 §2,§3](01-architecture.md) |
| Supabase | The four client factories (`server`/`browser`/`anon`/`admin`) with **parameterized env**, `proxy.ts` `updateSession`. | [01 §4](01-architecture.md) |
| `withRoute` | The wrapper + pipeline (audience → tenant → role/`can` → plugin → entitlement → rateLimit → validation). | [02 §4](02-reservation-core.md) |
| HTTP/validation | `jsonOk`/`jsonError`, `HttpError` + factories, PG‑error map, `parseJson`/`parseQuery`, the `{error,code,details,issues}` envelope. | [02 §5,§6](02-reservation-core.md), [12 §1.1](12-api-surface.md) |
| Identity | `requireClaims()` → `AuthContext` (memberships **and** guardianships), cached; profile bootstrap. | [02 §7](02-reservation-core.md), [05 §4](05-auth.md) |
| Tenancy | `defineTenancy`, `resolveTenant`, `assertMember`, `provisionTenant` (`create_tenant_with_owner`), `active_tenant_id` cookie + `switch-tenant`. | [02 §8](02-reservation-core.md) |
| RBAC | `AppRole`, `roleAtLeast`, `can(role,perm)`, the `Permission` type; `TERMINAR_PERMISSIONS` stub. | [02 §9](02-reservation-core.md), [04 §2,§3](04-roles-and-permissions.md) |
| i18n | `createI18n` (next‑intl routing/request/navigation), `cs`/`en`, single config. | [02 §13](02-reservation-core.md) |
| **DB / RLS recipe** | `@reservation-core/db`: `is_member_of()` (SECURITY DEFINER), `role_rank()`, `my_role()`, `guardian_can_act()`, `set_updated_at()`; the canonical RLS macro + a sample migration. | [02 §14](02-reservation-core.md), [03 §7](03-data-model.md), [04 §4,§5](04-roles-and-permissions.md) |
| CI + test harness | Vitest (unit/integration), Playwright scaffold, **pgTAP/SQL** RLS tests; `reservation-testing` tenant/user factories, RLS harness, fake Resend; `env.ts` Zod boot validation. | [01 §1,§8](01-architecture.md), [02 §3](02-reservation-core.md) |
| **Vertical slice** | login → `provisionTenant` → create a course → list courses, all under RLS, all through `withRoute`, with unit + RLS + one e2e test. | [00 §5](00-overview.md) |

**Exit criterion.** A member can **sign in, create a tenant, and CRUD a course under RLS** — the `courses` table
has working `staff_read`/`staff_write` policies via `is_member_of()`, the route is a real `withRoute`, and the
slice is green in unit, pgTAP‑RLS, and Playwright. This single thread exercises every core subsystem; if it
holds, the framework is real.

**Sequencing.** Build core packages bottom‑up (`domain`/`shared` → `db` → `server` → `i18n`/`ui`); wire the
slice last. The RLS recipe and `is_member_of()` come **before** any table so no domain ever inlines a membership
subquery (the recursion bug Restaurio hit, [03 §7](03-data-model.md)).

## 3. Phase 1 — Course management & termínář

**Goal.** The course is the spine ([06](06-courses-and-terminar.md)); make it real before anything enrols into
it.

**Deliverables**

- `public.courses` / `public.sessions` schema + RLS; the `course_status` state machine and `kind` invariants
  ([06 §2,§3](06-courses-and-terminar.md)).
- The **recurrence generator** — the client‑side wizard that expands a rule into an explicit, editable
  `Session[]`; **no rule persisted** ([06 §5](06-courses-and-terminar.md)). `generateSessions` + `computeExpiry`
  neighbours land as pure functions.
- Capacity / occupancy math (`effectiveCapacity`, `occupancy`, `isFull`) and the **atomic capacity RPC** pattern
  ([06 §4](06-courses-and-terminar.md), [03 §7](03-data-model.md)).
- The **termínář** surface: *Kurzy* list (buckets, search, filters) + *Kalendář* month grid + coach session
  calendar ([06 §6](06-courses-and-terminar.md)); the course editor tabs (*Detail/Termíny/Lektoři/Viditelnost*).
- `coach_assignments` / `primary_coach_id` and **own‑scope** course RLS ([04 §4](04-roles-and-permissions.md)).
- **Configurable field schema + Settings** ([15](15-configurable-fields-and-settings.md)): `core.field_sets` +
  `core.field_definitions` ([03 §4a](03-data-model.md), migration 0004) + RLS; the kernel **`fields` module**
  (`applyPreset` / `resolveFields` / `buildZodSchema` / `buildFormDescriptor` / `splitValues` / `mergeValues`,
  [02 §13a](02-reservation-core.md)); the `kids-course` + `adult` **presets**; the **Settings → Pole účastníka**
  admin UI with the system‑vs‑custom guardrails ([15 §6](15-configurable-fields-and-settings.md)); per‑course
  overrides. **Supersedes** the legacy `custom_field_definitions` / `course_field_assignments` — including the
  one‑off **migration** of legacy custom fields ([15 §10](15-configurable-fields-and-settings.md)).
- Course/session endpoints ([12 §2.3](12-api-surface.md)); ICS feed ([06 §6.4](06-courses-and-terminar.md)).

**Exit criterion.** A coach generates a 7‑session weekly block with a holiday exception, edits one session, and
the calendar/list render it from the flat `sessions` table; a coach can edit **own** but not others' courses
(enforced by RLS, proven by pgTAP). `capacity` cannot drop below peak occupancy (`422 CAPACITY_BELOW_OCCUPANCY`).
An admin relabels a system field and adds a custom field in **Settings → Pole účastníka**, and a course shows a
per‑course override — all from `core.field_definitions`, with `buildZodSchema` validating identically
client+server ([15](15-configurable-fields-and-settings.md)).

**Sequencing.** Schema + RLS → generator (pure, testable first) → editor UI → calendar/list. The *Omluvenky* and
*Cena* editor tabs are stubs here (filled in Phase 3 / Phase 4).

## 4. Phase 2 — Enrollment

**Goal.** Both doors into `public.enrollments` ([07](07-registration-and-enrollment.md)), plus the **family
identity** and the **transactional email** the funnel needs.

**Deliverables**

- `public.participants`, `public.applications`, `public.enrollments`, `participant_field_values` + RLS
  ([03 §4,§5](03-data-model.md)).
- The **public QR funnel** — the 4‑step wizard (child → contact → course → slot+GDPR → done), age
  recommendation (`ageMonths`/`matched`), slot chips from `occupancy()`
  ([07 §2](07-registration-and-enrollment.md)).
- The **approval queue** (*Přihlášky*) and the *Zapsat*/*Zamítnout*/*Vrátit* actions; the **approval
  transaction** (SECURITY DEFINER: dedupe + atomic capacity + enrollment, [07 §4.1](07-registration-and-enrollment.md)).
- **Manual staff enrollment** (*Nový účastník*) ([07 §5](07-registration-and-enrollment.md)); guardian/participant
  **dedupe** keyed on `guardian_email` ([07 §6](07-registration-and-enrollment.md)); waitlist + `staff_only`
  ([07 §8](07-registration-and-enrollment.md)).
- **Render both forms from the field schema** ([15 §4](15-configurable-fields-and-settings.md)): the public QR
  form (`public_form`) **and** the *Nový účastník* modal (`admin_form`) are generated from the tenant's
  participant/guardian/enrollment field sets via `buildFormDescriptor`, validated by the shared
  `buildZodSchema`, and persisted via `splitValues` (spine columns + `custom` jsonb) — no hardcoded field lists
  ([07 §5,§7](07-registration-and-enrollment.md)). The portal surface (`portal`) follows.
- **Guardian↔Participant** model: `core.guardianships`, the claim/link flows on approval and *Přidat dítě*
  ([04 §7](04-roles-and-permissions.md), [05 §3](05-auth.md)).
- **Magic‑link portal auth** + OAuth/OTP + safe‑links ([05 §2c–§2f](05-auth.md)); the `/auth/callback` outside
  `[locale]`.
- The **Resend transactional layer** and the first templates (`application.received/approved/rejected`,
  `enrollment.confirmed`, `auth.magic_link`/`otp`, `staff.invite`) — localized, idempotent, graceful, branded
  ([02 §11](02-reservation-core.md), [10 §1,§2](10-notifications-and-email.md)).
- Public/portal/auth endpoints ([12 §2.1,§2.4,§2.5,§2.7,§2.8](12-api-surface.md)); rate limits on the
  auth‑adjacent + submit routes ([12 §4](12-api-surface.md)).

**Exit criterion.** A parent scans the QR, submits an application, gets the confirmation email; staff approve;
the child becomes an enrolled participant; the parent signs in to the portal by magic link and sees "my
children". A failed email **does not** break enrollment ([07 §9](07-registration-and-enrollment.md)); a double
active enrollment is `409 CONFLICT`.

**Sequencing.** Identity + Resend first (enrollment side‑effects need both) → public funnel → approval/manual →
portal login. The `core.outbox` event bus lands here in skeleton form (so `enrollment.created` →
`enrollment.confirmed` is decoupled), then is fully exploited in Phase 3/4.

## 5. Phase 3 — Attendance & omluvenky (the differentiator)

**Goal.** The signature subsystem ([08](08-attendance-and-omluvenky.md)) — the reason the product exists
([00 §1](00-overview.md)). After this phase the **entire end‑to‑end story from [00 §5](00-overview.md) works**.

**Deliverables**

- `public.attendance` / `excuses` / `credits` / `makeups` / `credit_audit` schema + RLS (staff + family
  predicates, [03 §6](03-data-model.md)).
- **Recording attendance** (*Docházka*): present/excused/absent, bulk present, idempotent; excused → excuse →
  issuance ([08 §2](08-attendance-and-omluvenky.md)).
- The **pure‑domain credit core** (`decideIssue`, `computeExpiry`, `isRedeemableNow`, FIFO selection) — built and
  unit‑tested **before** any UI, exactly the test list in [08 §13](08-attendance-and-omluvenky.md).
- **Per‑course expiry policy** (`none`/`ttl`/`course_end`/`windows`), the *Omluvenky* editor tab + tenant
  defaults ([08 §5,§12](08-attendance-and-omluvenky.md)).
- **Self‑excuse** before the deadline ([08 §3](08-attendance-and-omluvenky.md)) and the **safe‑link**
  self‑excuse from a reminder email ([05 §2f](05-auth.md), [10 §2](10-notifications-and-email.md) row 5).
- **Redemption**: the portal makeup finder (age slider + week grid) and `redeem_credit_into_session` (match +
  atomic capacity, [08 §6](08-attendance-and-omluvenky.md)); cancel‑with‑restore.
- **Staff credit management + audit** (Extend/Re‑tag/Cancel/Grant, append‑only `credit_audit`,
  [08 §8](08-attendance-and-omluvenky.md)); auto‑excuse on session/course cancellation ([08 §9](08-attendance-and-omluvenky.md)).
- **Reporting** (*Přehled* + studio credit liability, [08 §10](08-attendance-and-omluvenky.md)); the
  `excuse.confirmed` / `credit.issued` / `makeup.booked` emails with the **correct `creditIssued` flag**
  ([10 §2](10-notifications-and-email.md) row 6).
- Attendance/credit endpoints + the `attendance:‹sessionId›` realtime channel ([12 §2.6,§3](12-api-surface.md)).

**Exit criterion.** The full **doc‑00 story** runs: coach marks a child excused → an omluvenka is minted with
the course's expiry → the parent books a makeup into a free, age‑appropriate session → the balance decrements;
two parents racing for the last seat — one gets `SESSION_FULL` (atomic RPC); the excuse email says the *right*
thing about the credit. All [08 §13](08-attendance-and-omluvenky.md) pure tests pass.

**Sequencing.** Pure domain (`domain/credits/*`) first → attendance recording → issuance via
`attendance.excused` → expiry policy UI → redemption/makeup → staff mgmt + reporting. Expiry is evaluated **live
at redeem**; the nightly "flip to expired" job is cosmetic ([08 §5](08-attendance-and-omluvenky.md)).

## 6. Phase 4 — Plugins & subscriptions

**Goal.** Turn the entitlement/plugin machinery from theoretical into real revenue:
[09](09-plugins-and-subscriptions.md).

**Deliverables**

- The **Plugin SDK runtime**: `definePlugin`, the registry, the five seams (DB schema / routes / events / UI
  slots / settings), `assertPluginEnabled` (activation **AND** entitlement), lifecycle (register → enable →
  `onEnable` → runtime → disable) ([02 §12](02-reservation-core.md), [09 §1,§2,§4](09-plugins-and-subscriptions.md)).
- **Entitlements / tiers**: `TIER_ENTITLEMENTS` (`free`/`studio`/`pro`), `checkEntitlements`,
  `assertWithinLimit`; the *Pluginy* admin grid; gating wired into `withRoute({ plugin, entitlements })`
  ([09 §3](09-plugins-and-subscriptions.md)).
- The **`payments` plugin** — **build billing before course payments** ([09 §9](09-plugins-and-subscriptions.md)):
  tenant subscription + the **materialized‑tier loop** (Stripe webhook → `tenants.tier`, FDW fast path,
  reconciliation, [09 §3.3,§3.4,§5.4](09-plugins-and-subscriptions.md)); then course payments (Checkout +
  orders + Connect, [09 §5.2.2,§5.3](09-plugins-and-subscriptions.md)) and the refund↔omluvenka interplay
  ([09 §5.5](09-plugins-and-subscriptions.md)).
- The **`sms` plugin** — provider port (Twilio/SMSbrana), the subscribed events, consent/quiet‑hours/cost,
  `SmsSettings`, templates ([09 §6](09-plugins-and-subscriptions.md)); depends on the scheduler +
  `notification_preferences` ([10 §9,§6](10-notifications-and-email.md)).
- The **scheduler** (Vercel Cron): reminder sweep, credit‑expiry sweep, weekly digest, reconcile & cleanup —
  the only producer of the time‑based events ([10 §9](10-notifications-and-email.md), [12 §2.10](12-api-surface.md)).
- The **notification‑preferences** model + the email/SMS/in‑app routers and the **bell** (realtime
  `core.notifications`, [10 §6,§7,§8](10-notifications-and-email.md)).
- (Proofs) `ratings` and `booking-calendar` — that the SDK generalizes beyond money/messaging
  ([09 §7](09-plugins-and-subscriptions.md)).
- Plugin/webhook/cron endpoints ([12 §2.9,§2.10](12-api-surface.md)).

**Exit criterion.** A studio subscribes via Stripe Checkout; the webhook materializes `tenants.tier=studio`; the
*Pluginy* grid lets the owner enable `payments` (entitled) but shows *Upgradovat plán* for `sms` (not on
`studio`); a downgraded tenant immediately fails `assertPluginEnabled` (entitlement half). A reminder fires from
the scheduler through the bus to email and (where opted‑in + `pro`) SMS. No plugin writes a `core.*`/`public.*`
table outside published calls (CI denylist green, [09 §8](09-plugins-and-subscriptions.md)).

**Sequencing.** SDK runtime + entitlements → `payments` (billing → course) → scheduler + preferences →
`sms` → `ratings`/`booking-calendar` ([09 §9](09-plugins-and-subscriptions.md)).

## 7. Phase 5 — Hardening & GA

**Goal.** Take the feature‑complete product to **general availability**: the quality bar in
[00 §8](00-overview.md) and the security posture in [01 §10](01-architecture.md), made real.

**Deliverables**

| Track | Work | Ref |
|---|---|---|
| Design system | Mantine theme/token polish, `<PluginSlot>` finish, empty/loading/error states across all four surfaces. | [01 §1](01-architecture.md), [02 §3](02-reservation-core.md) |
| Accessibility | a11y pass (keyboard, ARIA, contrast) on funnel/portal/admin; plain‑text email parts. | [10 §3](10-notifications-and-email.md) |
| Performance | index audit of the hot paths; cacheable public reads via `anon` client; RSC‑first first paint. | [03 §8](03-data-model.md), [01 §6](01-architecture.md) |
| Observability | structured logs (request/tenant/user id, **no PII**), Sentry, `DomainError` dashboards, email/SMS delivery panels. | [01 §9](01-architecture.md), [10 §5](10-notifications-and-email.md) |
| Security review | RLS coverage (default‑deny on **every** table), service‑role fence (lint + dir rules), safe‑link entropy/HMAC, 2FA for owners/operators. | [01 §4,§10](01-architecture.md), [04 §6](04-roles-and-permissions.md), [05 §6](05-auth.md) |
| Rate limits | the full bucket set live (`magic-link`/`otp`/`password`/`application`/`self-excuse`/…) + lockouts. | [05 §6](05-auth.md), [12 §4](12-api-surface.md) |
| GDPR | export/erase paths, consent capture + versioning, retention purge job, EU residency, `List-Unsubscribe`. | [03 §10](03-data-model.md), [05 §6](05-auth.md), [10 §6](10-notifications-and-email.md) |
| White‑label | per‑tenant branding (logo/colors/from‑name/reply‑to), `poweredBy` removal on `pro`, custom **sending** domains (DKIM/DMARC). | [09 §3.2](09-plugins-and-subscriptions.md), [10 §4](10-notifications-and-email.md) |
| Docs / API | the **generated OpenAPI** from Zod, the typed client, and the `apiAccess` (`pro`) public surface. | [12 §5,§1.6](12-api-surface.md) |

**Exit criterion.** A clean external security review of RLS + service‑role fencing + safe‑links; a11y and perf
budgets met on all four surfaces; GDPR export/delete demonstrably complete; a `pro` tenant runs fully
white‑labelled on a custom sending domain; the OpenAPI doc is generated in CI and matches enforcement. Ship.

**Sequencing.** Security + GDPR + rate limits are blockers and go first; design/a11y/perf run in parallel;
white‑label depends on Phase 4's tiers; docs/OpenAPI close it out.

## 8. Phase 6 — Adopt core elsewhere

**Goal.** Realize the original thesis ([00 §1](00-overview.md), [02 §1](02-reservation-core.md)): refactor
**NaLekci** (`main-panel`) and **Restaurio** (`admin-console`) onto the now‑proven `reservation-core`, deleting
the duplicated plumbing. Done **after GA** so the two apps adopt a *stable, versioned* core, not a moving target.

**What each app must change**

| Change | From (legacy) | To (core) | Ref |
|---|---|---|---|
| **Tenant noun** | `instructor`/`studio` (main-panel), `restaurant` (admin-console) | `defineTenancy({ tenantTable, membershipTable, tenantTerm })` — config, not code. | [02 §2,§8](02-reservation-core.md) |
| **RLS membership** | inline membership subquery (main-panel); inline → **recursion bug** (admin-console) | `core.is_member_of()` (SECURITY DEFINER) everywhere; the canonical policy macro. | [02 §14](02-reservation-core.md), [03 §7](03-data-model.md) |
| **Route wrapper** | `withAuthRoute` (instructor‑coupled / restaurant‑coupled) | one `withRoute` ([02 §4](02-reservation-core.md)); audiences + `can`. | [02 §4](02-reservation-core.md) |
| **HTTP stack** | duplicate `jsonOk`/`jsonError` pair (the two apps disagree) | the single promoted HTTP/error stack. | [02 §5](02-reservation-core.md) |
| **i18n** | two configs, `cs` vs `en` default drift (Restaurio) | one `createI18n` factory, single config. | [02 §13](02-reservation-core.md) |
| **Email** | main-panel Resend / admin-console Edge fn (no localization) | the localized `sendEmail` contract. | [02 §11](02-reservation-core.md) |
| **Roles** | `employee < admin < owner` | `staff < coach < admin < owner` (rename `employee→staff`; `coach` is course‑domain‑specific, optional per app). | [04 §2](04-roles-and-permissions.md) |
| **Entitlements/plugins** | concept‑only / absent | `TIER_ENTITLEMENTS` + the Plugin SDK + `assertPluginEnabled`. | [09](09-plugins-and-subscriptions.md) |

**Exit criterion.** Both apps run their existing product behaviour on `reservation-core` with a **single** http
stack, `is_member_of()`‑based RLS, one i18n config, and the parameterized tenant noun — the duplicated lines
(the reusability scorecard, [02 reusability scorecard](02-reservation-core.md)) deleted, with their test suites
green against the shared packages.

**Sequencing.** Migrate the **most decoupled subsystem first** in each app (http + i18n + Supabase factories),
then auth/tenancy (the riskiest — RLS rewrite to `is_member_of`), then the domain. Do one app fully before the
second so the migration playbook is proven once.

## 9. Risks & mitigations

| Risk | Why it bites | Mitigation |
|---|---|---|
| **RLS complexity / recursion** | A membership policy that reads `memberships` recurses (Restaurio's "infinite recursion in policy"); inline subqueries drift. | One `core.is_member_of()` (SECURITY DEFINER), authored in Phase 0 **before** any table; pgTAP/RLS tests per table; `memberships` self‑row‑only policies + SECURITY DEFINER RPCs for cross‑member reads ([03 §7](03-data-model.md), [04 §5](04-roles-and-permissions.md)). |
| **Plugin coupling** | A plugin reaching into `core.*`/`public.*` would re‑introduce the entanglement the SDK exists to prevent. | The five seams only; schema‑scoped `admin` client (never global `getAdminClient()`); CI **denylist** fails any migration touching `core/public/auth/storage`; routes auto‑wrapped with `assertPluginEnabled` ([09 §1,§7,§8](09-plugins-and-subscriptions.md)). |
| **Migration of existing apps** | Big‑bang refactors of two live apps onto a new core risk regressions and a moving target. | Phase 6 is **post‑GA** (stable, versioned core); migrate decoupled subsystems first, one app fully before the next; existing test suites are the regression gate (§8). |
| **Omluvenka edge cases** | Excuse→credit→redeem has many corners (correction, expiry‑during‑booking, FIFO, double‑book, mid‑season feature off) where legacy bugged. | The rules are **pure functions** in `domain/` with the explicit truth‑table tests ([08 §11,§13](08-attendance-and-omluvenky.md)); side effects can't hold the logic; atomic capacity RPC for the race ([08 §6](08-attendance-and-omluvenky.md)). |
| **Email deliverability** | A failed/bounced email or a wrong "you got a credit" message broke legacy flows / trust. | `sendEmail` never throws into the request (`ok/skipped/error`); idempotency keys; SPF/DKIM/DMARC, plain‑text part, `List-Unsubscribe`; **row‑6 fix** passes the issuance decision, never re‑derives it; bounces tracked in `email_events` ([02 §11](02-reservation-core.md), [10 §2,§4,§5](10-notifications-and-email.md)). |
| **Capacity races** | Two guardians/applicants grabbing the last seat → overbooking. | `select … for update` atomic RPC on the counted rows before insert, generalized from `main-panel` ([03 §7](03-data-model.md), [06 §4](06-courses-and-terminar.md), [08 §6](08-attendance-and-omluvenky.md)). |
| **Tier staleness** | A missed Stripe webhook leaves `tenants.tier` wrong, granting/denying paid value. | Request‑time tolerates staleness (column read); **money‑time goes live** to Stripe; nightly reconciliation corrects drift ([09 §3.3,§3.4](09-plugins-and-subscriptions.md)). |
| **Scope creep past v1** | Native apps / full LMS / invoicing / cross‑tenant marketplace could derail GA. | The out‑of‑scope line is explicit ([00 §2](00-overview.md)); those are "designed‑for, not built". |

## 10. Definition of done (per phase) & test strategy

### 10.1 Per‑phase DoD checklist

Every phase ships only when **all** of the following hold for its deliverables:

- [ ] **RLS**: every new table default‑deny with `is_member_of()`/`guardian_can_act()` policies; a **pgTAP** test
      proves both allow and deny ([03 §7](03-data-model.md), [04 §4](04-roles-and-permissions.md)).
- [ ] **Routes**: every endpoint is a `withRoute(...)` with the right `audience`/`minRole`/`can`/`plugin`; no
      raw handler; errors map to the standard codes ([12 §1.2](12-api-surface.md)).
- [ ] **Validation**: every mutation has a Zod `body`/`query` schema, shared client↔server ([02 §6](02-reservation-core.md)).
- [ ] **Domain purity**: new rules (expiry, issuance, capacity, permissions, recurrence) are pure functions in
      `domain/` with unit tests **before** any I/O wrapper ([01 §3](01-architecture.md), [08 §13](08-attendance-and-omluvenky.md)).
- [ ] **i18n**: no hardcoded user‑facing string; emails localized per recipient ([00 §8](00-overview.md), [10 §3](10-notifications-and-email.md)).
- [ ] **Events/idempotency**: side effects go through `core.outbox` where decoupling matters; webhooks/cron/email
      are idempotent ([09 §5](09-plugins-and-subscriptions.md), [10 §1,§9](10-notifications-and-email.md)).
- [ ] **e2e**: the phase's headline user journey is a green Playwright test on its surface.
- [ ] **Lint/types**: `strict: true`, the layer‑boundary rule and the service‑role/plugin fences pass
      ([01 §3,§4](01-architecture.md)).

### 10.2 Cross‑cutting test strategy

The legacy system shipped features 001–011 **without tests** and paid for it ([00 §7](00-overview.md)); this
build is test‑first from Phase 0. Three layers, matching the architecture ([01 §1,§3](01-architecture.md)):

| Layer | Tool | What it covers | Where it lives |
|---|---|---|---|
| **Unit — domain** | Vitest | Pure policy: `computeExpiry`/`isRedeemableNow`/`decideIssue`, FIFO, `effectiveCapacity`/`occupancy`, `roleAtLeast`/`can`, `generateSessions`, `resolveEmailLocale`. | `domain/**` ([08 §13](08-attendance-and-omluvenky.md)) |
| **Integration — RLS / DB** | pgTAP + Vitest against **real Postgres** | Every table's allow/deny per role + family predicate; the SECURITY DEFINER RPCs (`provisionTenant`, approval, `redeem_credit_into_session`, `transfer_ownership`); **atomic capacity under simulated concurrency**. | `db/tests/**`, `reservation-testing` harness ([02 §3](02-reservation-core.md), [03 §7](03-data-model.md)) |
| **E2E — per surface** | Playwright | One journey per surface: admin (create course → take attendance), public (QR funnel → application), portal (magic‑link → book makeup), ops (cross‑tenant). Webhook/cron flows driven via fixtures. | `apps/terminar/e2e/**` |

Plus a **fake Resend** and provider stubs ([02 §3](02-reservation-core.md)) so email/SMS/Stripe paths are tested
without hitting vendors, and the `idempotencyKey`/dedupe assertions guard the retry paths.

## 11. Team & parallelization

A clean **core team / app team** split keyed to the package boundary ([01 §2](01-architecture.md)):

- **Core team** owns `packages/kernel/*`, `reservation-ui-mantine`, the RLS recipe, the Plugin SDK,
  and the entitlements engine — the product‑agnostic 60 % ([00 §1](00-overview.md)). They lead Phase 0, keep the
  packages versioned, and shepherd Phase 6.
- **App team** owns `apps/terminar` — the course/omluvenka domain, the four surfaces, the templates — consuming
  the core's primitives ([02 §15](02-reservation-core.md)).
- **Parallelization.** After Phase 0's vertical slice freezes the core contracts, the two teams run in parallel:
  the app team builds Phases 1–3 against stable `withRoute`/RLS/i18n while the core team builds the **Plugin SDK
  + entitlements** (Phase 4 prerequisites) ahead of need. The monorepo makes this safe — a change to `withRoute`
  is type‑checked against every consumer in one CI run ([01 §2](01-architecture.md)) — so the core can evolve
  without silently breaking the app. The two first‑party **plugins** (`payments`, `sms`) are natural sub‑teams
  once the SDK lands, in the build order of [09 §9](09-plugins-and-subscriptions.md).

This is where the spec ends: the foundation ([02](02-reservation-core.md)) is built first and proven, the
product ([03](03-data-model.md)–[12](12-api-surface.md)) is layered on in dependency order, and the same core
ultimately carries three apps.
