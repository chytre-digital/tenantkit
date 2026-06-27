# 07 — Registration & enrollment

> How a person gets **into** a course. Two doors: the **public QR enrollment funnel** (anonymous → an
> `applications` row → staff approval → an `enrollments` row) and **manual staff enrollment** (straight to an
> `enrollments` row). This document is the authority on the 4‑step public wizard, the approval workflow, the
> manual *Nový účastník* path, guardian/participant creation & dedupe, custom‑field collection, the waitlist /
> `staff_only` mode, and the registration edge cases. Schema names are authoritative in [03](03-data-model.md);
> the omluvenka economy that follows enrollment is [08](08-attendance-and-omluvenky.md); auth & magic‑links are
> [05](05-auth.md). UX = the [QR formulář] mockup (public funnel) and the [Admin] *Přihlášky* mockup (queue).

## 1. The two doors (overview)

```
  Public QR form (anon)                         Staff (admin console)
        │ submit                                       │ "Nový účastník"
        ▼                                              ▼
  public.applications (pending) ── approve ──▶ public.participants (+ core.participant_accounts)
        │  reject                                      │
        ▼                                              ▼
   (notify, no enrollment)                      public.enrollments (active)
                                          source = 'application' | 'staff' | 'makeup'
```

Both doors converge on **`public.enrollments`** (the **Zápis**), differing only by `source`. Public
submissions are *pending* until staff act; staff‑added enrollments are immediate. Capacity is **re‑checked
atomically** at the moment a seat is actually taken (approval / staff add), never trusted from the form.

> **Both forms are generated, not hardcoded.** The public QR form **and** the manual *Nový účastník* modal are
> rendered from the tenant's **participant / guardian / enrollment field sets** — the configurable, surface‑aware
> field schema ([15](15-configurable-fields-and-settings.md), [03 §4a](03-data-model.md)). The field lists shown
> in this document are Termínář's **default `kids-course` preset** (child + guardian); an adult‑studio tenant
> seeds the `adult` preset and gets a different form with no code change. The two surfaces select their fields by
> `surface` (`public_form` vs. `admin_form`); the same `buildZodSchema` validates both client and server
> ([15 §3,§5](15-configurable-fields-and-settings.md)). The mapping of the eight modal fields to the system
> spine is [15 §4.1](15-configurable-fields-and-settings.md).

## 2. The public QR enrollment funnel

A **mobile‑first**, anonymous, 4‑step wizard reachable by **QR code** at an open day (the mockup header:
*"Den otevřených dveří · zápis"*). The QR **deep‑links a context** — `‹slug›.terminar.cz/zapis/[course?]` —
so the tenant is resolved by **subdomain/host** ([02](02-reservation-core.md) §8, public surface) and an
optional course/open‑day pre‑selects Step 2. No account is required; the only persistence is one
`public.applications` row on submit. A top progress bar shows *Krok N ze 4* with a step label, a sticky footer
carries *Zpět* / *Pokračovat* (→ *Uložit rezervaci* on the last step), and **Pokračovat is disabled until the
step validates** (the mockup's `canNext()` gate, mirrored server‑side on submit).

### Step 0 — Dítě (child)

*"Koho přihlašujete?"* — collect **Jméno dítěte** (`child_name`) and **Datum narození** (`child_dob`, a
`date`). The moment a valid DOB is entered, the form **computes age in months** and **suggests a course**:

```ts
// age in months, exactly as the mockup's ageMonths()
function ageMonths(dob: DateOnly, today = now()): number | null {
  let m = (today.getFullYear() - d.getFullYear()) * 12 + (today.getMonth() - d.getMonth())
  if (today.getDate() < d.getDate()) m--          // not yet reached this month's day
  return m < 0 ? null : m
}
// recommend: first course whose [age_min_months, age_max_months] contains the age
const match = courses.find(c => m >= c.age_min_months && m <= c.age_max_months) ?? null
```

A green hint confirms the read — *"{{Jméno}} má {{m}} měsíců (… let). Podle věku rovnou nabídneme vhodný kurz —
{{matchName}}."* Czech month pluralization (`měsíc` / `měsíce` / `měsíců`) is applied. **Gate:** non‑empty name
**and** a parseable DOB (age ≥ 0). The recommendation pre‑selects Step 2's course but never forces it.

### Step 1 — Kontakt na rodiče (parent contact)

Collect the guardian's **Jméno a příjmení** (`guardian_name`), **E‑mail** (`guardian_email`, validated
`.+@.+\..+`), **Telefon** (`guardian_phone`, `tel`), and **Jak jste se o nás dozvěděli?** — a `source` select
(*Doporučení od známých · Instagram / Facebook · Náš web · Leták / plakát · Jiné*) stored as `applications.source`.
**Gate:** name + valid email + non‑empty phone.

### Step 2 — Výběr kurzu (course pick, age‑recommended, overridable)

*"Vhodný kurz podle věku."* Renders the catalogue as cards; each shows the course **name**, its **age band in
months** as a chip (`{{min}}–{{max}} měs.`), a short description, and — on the age‑matched card — a
*"Doporučeno podle věku"* sparkle. The recommended course is pre‑selected (filled check), but the parent may
**override** to any course ("když je dítě zdatnější"). The chosen `course_id` is carried forward. (Only
`status='active'`, `show_on_public=true` courses appear — the anon catalogue RLS, [03](03-data-model.md) §7;
`staff_only` courses are absent, §8.) **Gate:** a course selected.

### Step 3 — Termín a souhlas (slot pick + GDPR)

*"Vyberte termín."* The chosen course's sessions are grouped by **day** with **time chips**; each chip shows
**occupancy as `taken/cap`** (e.g. `5/7`) — the number being *obsazeno / kapacita* from
`occupancy()`/`effectiveCapacity()` ([06](06-courses-and-terminar.md) §4). Colour thresholds match the shared
badge scale (free → sage, ≤ 2 left → ochre, full → clay). A **full** chip renders *Obsazeno*, dimmed and
**disabled** (`pointer-events:none`). Below the grid, a required **GDPR consent** checkbox — *"Souhlasím se
zpracováním osobních údajů za účelem zápisu do kurzu."* with a *Více informací* link. **Gate:** a non‑full slot
selected **and** consent ticked (the mockup's `sl && free>0 && gdpr`). The selected session becomes
`applications.desired_session_id`; ticking consent stamps `gdpr_consent_at` at submit.

### Done — Hotovo (confirmation)

*"Rezervace uložena."* — a success screen with a **summary card** (Dítě, Kurz, Termín, Rozsah "N lekcí") and
the line *"Potvrzení posíláme na {{email}}."* Submitting performs **one** write — `public.applications` with
`status='pending'`, the captured contact + `child_*`, `source`, `custom` answers (§7), `gdpr_consent_at`, and a
freshly minted `safe_link_token` — then fires a **localized confirmation email** ([02](02-reservation-core.md)
§11) carrying that safe‑link so the family can track/confirm the application **without an account** ([05](05-auth.md)).
A *Nová rezervace* button resets the wizard for the next family at the open day.

```
POST /api/zapis/applications                 (withRoute: audience 'public', tenantFrom 'host',
                                              rateLimit { key: 'application', limit: 5, window: '10m' },
                                              body: CreateApplicationSchema)
→ inserts public.applications (status='pending'); sends enroll.application_received email
```

## 3. The data a submission writes

A submission is **anonymous** — it creates a `public.applications` row, *not* an account or a participant. The
tenant is resolved by **slug/host**, never sent by the client. Key columns (DDL in [03](03-data-model.md) §5):

| Field | Source | Notes |
|---|---|---|
| `tenant_id` | resolved from host | Server‑side; the anon client may only insert into its tenant (RLS). |
| `course_id`, `desired_session_id` | Step 2 / Step 3 | The requested course + slot; either may be re‑assigned on approval. |
| `child_name`, `child_dob` | Step 0 | Age is computed from `child_dob`, never stored. |
| `guardian_name`, `guardian_email`, `guardian_phone` | Step 1 | `guardian_email` is the **dedupe key** at approval (§6). |
| `source` | Step 1 | "how did you hear about us." |
| `custom` (jsonb) | §7 | Answers to the course's assigned custom fields. |
| `gdpr_consent_at` | Step 3 | **Required** (NOT NULL); the consent timestamp. |
| `status` | — | `pending` → `approved` \| `rejected`. |
| `safe_link_token` | generated | Opaque token in the confirmation email; login‑less track/confirm ([05](05-auth.md)). |

Validation is symmetric: the same Zod primitives (`emailSchema`, `czPhoneSchema`, `dateOnlySchema`) run in the
form **and** in `CreateApplicationSchema` on the route ([02](02-reservation-core.md) §6), so a hand‑crafted POST
can't bypass the client gates.

## 4. The approval workflow (admin *Přihlášky*)

The [Admin] *Přihlášky* screen is a **review queue**. A banner explains the source: *"Přihlášky přicházejí z
veřejného zápisového formuláře (QR kód). Zkontrolujte údaje a přihlášku zapište jako nového účastníka, nebo ji
zamítněte."* Three **stat cards** summarize the pipeline, a **filter** segments the table, and each row carries
**per‑row actions**.

**Stats** (mockup `subStats`): **Nové přihlášky** (`status='pending'`), **Zpracováno** (approved), **Zamítnuto**
(rejected). **Filter tabs:** `Vše` · `Nové` · `Zapsané` · `Zamítnuté` (with counts).

**Table columns:** *Dítě* (name + age) · *Zákonný zástupce* (name + email + phone) · *Požadovaný kurz* (course +
slot · source) · *Přijato* (submitted‑at) · *Stav* (badge) · *Akce*.

**Status badges** (mockup `SUB_BADGE`):

| Row state | CZ | bg / fg |
|---|---|---|
| pending | **Nová** | `#d9e7e3` / `#2f544e` |
| approved | **Zapsáno** | `#dde7d4` / `#3a5a40` |
| rejected | **Zamítnuto** | `#f4e0db` / `#803129` |

**Per‑row actions:**

| Action | CZ | When | Effect |
|---|---|---|---|
| **Approve** | **Zapsat** | pending | Runs the approval transaction (below). |
| **Reject** | **Zamítnout** | pending | `status='rejected'`, stamp `decided_by`/`decided_at`; sends a polite *not‑accepted* email. |
| **Reset** | **Vrátit** | decided | Returns the row to `pending` (undo a mistaken decision); reverses a just‑created enrollment if no attendance yet. |

### 4.1 Approve = the transaction

`POST /api/applications/:id/approve` (`withRoute`: staff, `minRole: 'staff'`, `can: 'applications:decide'`) runs
a single **`SECURITY DEFINER` RPC** so participant creation, enrollment, and the capacity check are atomic:

1. **Resolve / create the guardian account** by `guardian_email` (dedupe, §6) → a `core.participant_accounts` link.
2. **Resolve / create the participant** (`public.participants`) for the child under that guardian; copy
   `child_name`/`child_dob`; seed `participants.custom` from `applications.custom`.
3. **Re‑check capacity atomically** for the (re‑assignable) target course/session: `select … for update` on the
   counted seats vs `effectiveCapacity` ([06](06-courses-and-terminar.md) §4); if full →
   `422 SESSION_FULL` (the row stays `pending`; staff may pick another slot or waitlist, §8).
4. **Create the enrollment**: `public.enrollments(source='application', application_id=…, status='active')`;
   copy custom answers into `public.participant_field_values` (§7).
5. **Mark the application** `status='approved'`, `decided_by`, `decided_at`.
6. **Side effects** (decoupled via `core.outbox`, [02](02-reservation-core.md) §12): emit
   `enrollment.created` → a **localized confirmation email** plus a **guardian magic‑link / claim** so the
   family can finish setting up portal access ([05](05-auth.md)); the `payments` plugin (if enabled) reacts to
   create an order. The mockup confirms with the toast *"Přihláška zpracována – účastník zapsán."*

The partial‑unique index `enrollments(course_id, participant_id) where status='active'` ([03](03-data-model.md)
§5) makes a **double active enrollment** a `409 CONFLICT` — re‑approving the same child is a no‑op, not a
duplicate.

## 5. Manual staff enrollment (*Nový účastník*)

When a family enrolls in person/over the phone, staff skip the application entirely. The header *Nový účastník*
action opens a modal ([Admin] mockup) that creates a **participant + enrollment directly** with
`source='staff'`.

**Form fields** (the mockup's modal — i.e. the default `kids-course` preset, [15 §4.1](15-configurable-fields-and-settings.md);
the actual fields/labels/order come from the tenant's `admin_form`‑surfaced definitions, so this list is the
seed, not a hardcoded form):

| Field | CZ | Maps to |
|---|---|---|
| Child name | Jméno dítěte | `participants.full_name` |
| Date of birth | Datum narození | `participants.date_of_birth` |
| Guardian | Zákonný zástupce | guardian `full_name` (dedupe by email, §6) |
| Email | E‑mail | guardian email — **required, validated** |
| Phone | Telefon | guardian phone |
| Course | Kurz | the target `course_id` (select of active courses) |
| Payment status | Stav platby | seeds `enrollments.payment_status` (`paid` / `unpaid`) — informational unless the `payments` plugin owns it |
| Note | Poznámka | `participants.note` (the staff textarea) |

`saveAdd` validates **child name + guardian + a valid email** before submit (mockup: *"Vyplňte jméno, zástupce a
platný e‑mail."*). On save: same guardian/participant dedupe (§6) and the **atomic capacity RPC** as approval,
then `enrollments(source='staff', status='active')` and any assigned custom fields. Toast: *"Účastník byl
zapsán."* The same flow underlies the *Vrátit*‑then‑edit case and bulk import.

```
POST /api/enrollments                          (withRoute: staff, minRole 'staff', can 'enrollments:create',
                                                body: StaffEnrollSchema)
→ upsert guardian + participant, atomic capacity check, insert enrollments(source='staff')
```

## 6. Guardian & participant creation / matching (dedupe)

The identity model new to Termínář 2 ([00](00-overview.md), [03](03-data-model.md)): **one guardian account,
many child participants.** Both approval and staff enrollment use the **same dedupe**, keyed by
**`guardian_email`**:

```
upsertGuardianAndChild(email, guardianName, child):
  guardian = find core.profiles/auth.users by lower(email)
  if guardian exists:
      ensure a participant for `child` under this guardian
        (match by full_name + date_of_birth; else create a NEW participant)
      add a core.participant_accounts(user_id=guardian, participant_id=child, relation='parent') if absent
  else:
      provision a family account (passwordless; activated via magic-link/claim, doc 05)
      create the participant, create the participant account
  return { guardianUserId, participantId }
```

Consequences:

- **Existing guardian → new child is *added*** to the same account (a parent with two kids gets a real "my
  children" portal view), never a duplicate guardian.
- A re‑submission for the **same child** (same name + DOB under the same guardian) reuses the participant — the
  active‑enrollment unique index then prevents a duplicate course enrollment (§4.1).
- An **adult enrolling themselves** is modelled by a `self`‑relation participant account ([03](03-data-model.md) §3).
- The guardian account is only *provisioned*, not logged in, at approval; access is finished by the
  **magic‑link / claim** email ([05](05-auth.md)). Email is the join key precisely because the public form has
  no authenticated identity.

## 7. Custom field collection

Beyond the system spine, a tenant's **custom** field definitions (and any **per‑course** overrides) render as
extra inputs on the relevant surface — the public funnel (`public_form`) and/or the staff *Nový účastník* modal
(`admin_form`) — straight from the unified field schema ([15](15-configurable-fields-and-settings.md),
[03 §4a](03-data-model.md)); plugin‑contributed fields arrive the same way (`source='plugin:<id>'`,
complementing the `enrollment.form.extra` UI slot, [02 §12](02-reservation-core.md)). Field types are the
schema's `field_type` set (`text|textarea|email|phone|date|number|select|multiselect|boolean|segmented`); a
`select`/`segmented` field carries `options`. (This **supersedes** the legacy `course_field_assignments` /
`custom_field_definitions`, [03 §4](03-data-model.md).)

- **Required validation**: a field flagged `required=true` blocks *Pokračovat*/submit when empty (client) and is
  re‑validated server‑side by the **same** `buildZodSchema(fields)` woven into `CreateApplicationSchema` /
  `StaffEnrollSchema` → `400 VALIDATION_ERROR` ([15 §5](15-configurable-fields-and-settings.md)).
- **Storage**: on the application the raw answers live in `applications.custom` (jsonb); on approval / staff
  enroll, `splitValues` partitions them — spine fields to their typed columns, custom fields snapshotted into
  `participants.custom` / `enrollments.custom` (jsonb) for fast roster/profile display
  ([15 §3](15-configurable-fields-and-settings.md)).

## 8. Waitlist & the `staff_only` mode

**Waitlist (brief).** When the desired slot is **full** at submit/approve time, the application isn't lost: it
stays `pending` and is flagged **waitlisted** for that course/session. If a seat frees (a cancellation lowering
`occupancy`), staff see it surface and can *Zapsat* it; the atomic capacity RPC re‑checks at the moment of
approval, so a waitlisted approval still can't overbook. (This reuses the same seat‑count + `select … for
update` machinery the omluvenka makeup booking uses, [08](08-attendance-and-omluvenky.md) §6 — promotion is a
staff action, not automatic, in v1.)

**`registration_mode = staff_only`.** A course set to `staff_only` ([06](06-courses-and-terminar.md) §1) has
**no public form**: it is omitted from the anon catalogue and the QR funnel's Step 2, and a deep‑link to it
returns "not open for online registration." Such courses are filled **exclusively** by manual staff enrollment
(§5) — for invite‑only groups, internal cohorts, or courses managed entirely at the desk.

## 9. Edge cases & decisions

| Case | Decision |
|---|---|
| **Duplicate application** (same child + guardian, still pending) | Detected on submit by `(tenant, guardian_email, child_name, child_dob, course_id)`; the second is **merged/flagged** as a duplicate rather than creating a second queue row — staff see one entry. |
| **Course fills between submit and approval** | Approval's atomic capacity re‑check returns `422 SESSION_FULL`; the row stays `pending` and is **waitlisted** (§8). Staff may re‑assign to another slot/course before approving. |
| **Under‑age / over‑age vs the course band** | **Warn, don't block.** The form recommends by age but allows override; approval surfaces a soft *"mimo věkové rozmezí"* warning. Staff may enroll anyway (siblings, advanced kids). |
| **Invalid / unparseable DOB** | Step 0 gate fails (no age, no recommendation); the parent must fix it before proceeding. |
| **Reject then reconsider** | *Vrátit* returns the application to `pending`; it can then be approved normally. |
| **Approve, then *Vrátit*** | Reverses the just‑created enrollment **only if** no attendance/payment has accrued; otherwise staff cancel the enrollment explicitly. |
| **GDPR / consent** | `gdpr_consent_at` is mandatory to submit and is surfaced on the participant record ([03](03-data-model.md) §10). Rejected applications are **retained then purged** after N months by the scheduled retention job; an approved application's consent carries to the participant. |
| **Spam / abuse on the public form** | The public route is **rate‑limited** per identity/host ([02](02-reservation-core.md) §4); a failed email never breaks the submission (email is `skipped`, not an error — [02](02-reservation-core.md) §11). |
| **Email send fails at approval** | Enrollment still succeeds; the confirmation/magic‑link email is retried idempotently ([02](02-reservation-core.md) §11) — the legacy lesson that a mail failure must not block enrollment. |
