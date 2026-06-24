# 00 — Overview

## 1. Vision

Build **one foundation** (`reservation-core`) and **one flagship product** (Termínář 2) on top of it, such that:

- Termínář 2 ships faster and cleaner than the legacy .NET system because ~60 % of it (auth, tenancy,
  roles, HTTP plumbing, validation, email, entitlements, i18n, plugin runtime) is *the framework*, not
  the app.
- The same framework can later absorb **NaLekci.cz** (`main-panel`) and **Restaurio** (`admin-console`),
  which today re‑implement the same plumbing independently. The framework is designed by *reading what
  those two already share* and promoting it to a package.

Termínář 2 itself is a **course‑management platform for long‑term courses** — recurring, multi‑session
blocks such as a swim school's seasonal courses, a music school's terms, or a sports club's training
groups. Its signature feature is the **omluvenka** ("excuse note") workflow: an absence becomes a
makeup credit that the family can redeem into another session.

## 2. Goals & non‑goals

### In scope (v1)

1. **Multi‑tenant**: many independent organizations ("studios") on one deployment, fully isolated.
2. **Multi‑language**: Czech + English at launch, with the i18n machinery to add locales cheaply. Tenant
   default language + per‑user override.
3. **Course management** for long‑term/recurring courses: courses → sessions, a recurrence generator,
   capacity, a calendar ("termínář"), course states (draft → active → completed/cancelled).
4. **Participants & guardians**: real modeling of *a guardian managing one or more child participants*
   (and of self‑managing adult participants). **This is new** — legacy had only `name+email`.
5. **Self‑service enrollment**: a public, mobile‑first, QR‑reachable multi‑step application form;
   staff review → approve → enrol; manual staff enrollment too.
6. **Authentication** for the family side: **password / OAuth / magic link** (and OTP), plus password
   (and OAuth) for staff. Login‑less safe‑links for one‑shot actions.
7. **Attendance** per session (present / excused / absent), per‑participant and per‑course rollups.
8. **Omluvenka system**: excused absence → makeup credit with **per‑course expiration**, redeemable into
   another suitable session within capacity; full staff management & audit of credits.
9. **Transactional email** via Resend (localized), for confirmations, magic links, reminders.
10. **Plugin architecture** with **subscription‑gated activation**: ship `payments` and `sms` plugins
    (and `booking-calendar`, `ratings`) as the proof that the extension model works.

### Out of scope (v1, designed‑for not built)

- Native mobile apps (the public + portal surfaces are responsive PWAs).
- A full LMS (lesson content, grading, video). We track *attendance & logistics*, not curriculum.
- Accounting/invoicing beyond what the `payments` plugin needs (Stripe handles money; we store references).
- Marketplace discovery across tenants (each tenant is its own island; cross‑tenant search is a future idea).

## 3. Where this sits — the reservation category

The product lives in the same category as **Reservanto**, **Reenio**, **SuperSaaS**, **Bookla** and
similar Czech/EU booking systems: online reservations, a resource/staff calendar, a customer database,
payments, and SMS/email reminders. Termínář 2 differentiates by going deep on **long‑term course
cohorts and the omluvenka/makeup economy**, where generic booking tools are shallow. `reservation-core`
is what lets us compete on features: the boring 60 % is solved once.

## 4. Personas & primary surfaces

| Persona | CZ | Surface | Authenticates with | Core jobs |
|---|---|---|---|---|
| **Owner / Manager** | Majitel / Správce | Admin console | password / OAuth | Configure the studio, courses, staff, plugins, billing. |
| **Coach / Instructor** | Lektor / Trenér | Admin console (scoped) | password / OAuth | Own courses, take attendance, see own rosters & calendar. |
| **Front‑desk / Staff** | Recepce | Admin console (scoped) | password | Process applications, manage participants, record payments. |
| **Guardian / Parent** | Rodič / Zákonný zástupce | Participant portal | magic link / OAuth / password | Manage their children, excuse absences, book makeups, pay. |
| **Participant (adult)** | Účastník | Participant portal | magic link / OAuth / password | Same as guardian, for themselves. |
| **Applicant (anonymous)** | Zájemce | Public QR form | none (safe‑link follow‑up) | Apply to a course; confirm via emailed safe‑link. |
| **Platform operator** | Provozovatel | Ops/back‑office | password + 2FA | Onboard tenants, support, observe. Cross‑tenant. |

Four **access surfaces** (this is the "multimodal" axis — see [ADR‑0004](adr/0004-multimodal-core.md)):

1. **Admin console** — `app.terminar.cz` (or tenant subdomain), staff‑authenticated, role‑scoped.
2. **Public/marketing & enrollment** — `<tenant>.terminar.cz/zapis/...`, anonymous, the QR form & course list.
3. **Participant portal** — `<tenant>.terminar.cz/portal`, family‑authenticated, the omluvenka/makeup UI.
4. **Ops back‑office** — internal, platform‑operator only, cross‑tenant.

## 5. The end‑to‑end story (one paragraph)

A swim school ("Plavecká škola Delfínek") is a **tenant**. Its manager creates a **course** ("Plavání
pro předškoláky") as a recurring **block of 7 sessions**. A parent at an open day scans a **QR code**,
fills the **multi‑step form** (child + DOB → suggested course by age → contact → pick a time slot → GDPR),
and submits an **application**. Front‑desk **approves** it; the child becomes an enrolled **participant**
and a confirmation email goes out. Each week the coach opens **attendance** and marks present / excused /
absent. Marking a child *excused* mints an **omluvenka** (makeup credit) whose validity is governed by
the **course's expiration policy**. The parent opens the **portal**, sees their **credit balance**, and
in a weekly calendar **books a makeup** into any age‑appropriate session that still has free capacity —
spending one credit. If the studio has the **payments plugin** (on a paid plan), the same flows can take
money; with the **sms plugin**, reminders go by text.

## 6. Glossary (canonical — every doc uses these terms)

| Code term | CZ (UI) | Definition |
|---|---|---|
| **Tenant** | Studio / Škola | An isolated organization. The unit of multi‑tenancy. Has a `slug`. |
| **Membership** | Členství | A `(user, tenant, role)` link granting a staff user access to a tenant. |
| **Account / User** | Účet | A Supabase `auth.users` row. Either a staff member or a family account. |
| **Guardian** | Rodič / Zástupce | A family **account** that manages one or more participants. |
| **Participant** | Účastník / Dítě | The person attending a course. Belongs to a guardian (or is a self‑managing adult). |
| **Course** | Kurz | A long‑term offering = an ordered set of sessions, with capacity & policies. |
| **Session / Lesson** | Lekce | One scheduled occurrence of a course (start, duration, location). |
| **Application** | Přihláška | A submitted public registration form, *pending* staff approval. |
| **Enrollment** | Zápis | A confirmed participant↔course link (an approved application or staff‑added). |
| **Attendance** | Docházka | A per‑(session, participant) record: present / excused / absent. |
| **Excuse / Excusal** | Omluvení | The act/record of marking a participant excused for a session. |
| **Omluvenka (credit)** | Omluvenka / Náhradový kredit | A makeup credit minted by an excuse; redeemable into another session. |
| **Makeup (booking)** | Náhrada | A session booked by spending an omluvenka. |
| **Validity window** | Platnostní okno | A named date range during which credits may be redeemed (advanced expiry model). |
| **Safe‑link token** | Bezpečný odkaz | An opaque token in an email link granting login‑less, single‑purpose access. |
| **Plugin** | Plugin / Modul | An optional, per‑tenant feature module (payments, sms, …) gated by subscription. |
| **Entitlement** | Oprávnění plánu | A capability granted by the tenant's subscription tier; gates plugins & limits. |
| **Custom field** | Vlastní pole | A tenant‑defined extra question on the enrollment form / participant. |

## 7. What changes vs. legacy `terminar` (.NET)

The legacy system is a strong **domain reference** — we keep its best ideas and fix its known gaps.

**Keep (proven, port the concept):**
- The **omluvenka state machine** and the **window‑based credit expiry** model (excellent; see [08](08-attendance-and-omluvenky.md)).
- **Login‑less safe‑link** participant flows.
- **Per‑tenant plugin activation** + a `plugin_not_enabled` guard.
- **Fine‑grained `resource:action:scope` permissions**.
- The **frontend recurrence generator** that emits an explicit, editable session list (no recurrence rule persisted) — it handles holidays elegantly.
- **Custom participant fields** (YesNo / Text / Options).

**Fix / add (deliberate departures):**
1. **Stack**: .NET modular monolith → **Next.js + Supabase + Resend** (matches the team's other apps; lets us share `reservation-core`).
2. **Guardian↔Participant** is now first‑class (legacy had only `name+email`, so a parent with two kids and a real "my children" view was impossible).
3. **Consolidate participant auth**: legacy had *three* token schemes + two portals. We have **one portal** and use Supabase Auth (password / OAuth / magic link / OTP) + a single safe‑link concept.
4. **Per‑course excuse‑token expiration is first‑class** (the brief asks for it explicitly): a course sets a simple TTL *and/or* points at validity windows.
5. **Test‑first**: legacy shipped features 001–011 without tests and paid for it. `reservation-core` and the app are built with Vitest + Playwright from day one.
6. **Real approval workflow** for applications (legacy auto‑confirmed; the mockups show a review/approve queue).
7. **Localized email** (legacy hardcoded English); all transactional mail is i18n from the start.

See [ADR‑0001 — Stack](adr/0001-stack-nextjs-supabase-resend.md) for the stack rationale and
[`adr/0002-extract-reservation-core.md`](adr/0002-extract-reservation-core.md) for why the framework exists.

## 8. Quality bar & principles

1. **Tenant isolation is a database invariant**, not an app convention — enforced by RLS, verified by tests.
2. **The framework is headless.** `reservation-core` ships no required UI; an *optional* `@reservation-core/ui-mantine` preset carries the design system.
3. **One way to do a route.** Every API route goes through `withRoute(...)`. Every mutation validates with Zod. Every error is an `HttpError` or maps to one.
4. **Localized by default.** No user‑facing string is hardcoded; emails included.
5. **Plugins never touch core tables' code paths directly** — they extend through documented seams (DB schemas, event subscriptions, route namespaces, UI slots).
6. **Designed for white‑label.** Tokens, not hex codes, in components; a tenant can re‑skin.
