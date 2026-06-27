# 15 — Configurable fields & settings

> The authority on the **configurable, surface‑aware field schema**: how the *"Nový účastník"* form, the public
> QR form, and the portal are **data‑driven** from a per‑tenant set of field definitions rather than hardcoded.
> One field set, three surfaces, one validator. The schema is canonical in
> [`db/migrations/0004_fields.sql`](../db/migrations/0004_fields.sql) and summarized in
> [03 §4a](03-data-model.md); the capability lives in the kernel `fields` module ([02 §3](02-reservation-core.md));
> the decision is [ADR‑0011](adr/0011-configurable-field-schema.md). This unifies and **supersedes** the legacy
> `custom_field_definitions` / `course_field_assignments` ([03 §4](03-data-model.md)). UX anchor: the [Admin]
> *Nový účastník* modal and *Settings → Pole účastníka*; collection on the public funnel is
> [07 §7](07-registration-and-enrollment.md).

## 1. The problem — every app and every tenant has different participants

Termínář's mockup *"Nový účastník"* form is *Jméno dítěte · Datum narození · Zákonný zástupce · E‑mail · Telefon ·
Kurz · Stav platby · Poznámka* — a **kids' swim school** shape: a child, plus the adult who answers for them.
But that shape is **not universal**:

| App / tenant | Participant is | Guardian? | Wants extra |
|---|---|---|---|
| Swim school (Delfínek) | a **child** (Jméno dítěte) | **yes** (Zákonný zástupce) | — |
| Adult fitness studio | an **adult** (Jméno účastníka) | **no** (self) | — |
| Language school | a person | sometimes | *Úroveň* (A1…C2) select |
| Kids' camp | a child | yes | *Alergie*, *Nouzový kontakt*, plavec ano/ne |
| Music lessons | a child or adult | conditional | *Nástroj*, vlastní/zapůjčený |

The brief states it plainly: **„každá aplikace bude mít jiné uživatele/účastníky, proto je třeba aby tyto pole
člověk mohl nastavit v settings."** Hardcoding the eight modal fields makes the product single‑purpose — you
cannot relabel *Jméno dítěte* → *Jméno účastníka*, you cannot drop *Zákonný zástupce* for an adult app, and you
cannot add *Alergie* without a code change. Legacy `terminar` had `custom_field_definitions` for *extra*
questions only — it could relabel or remove **none** of the core fields. So:

> **The *Nový účastník* modal, the public QR form, and the portal must all render from a per‑tenant field
> schema** — seeded from an app **preset**, then edited in **Settings → Pole účastníka**. The same schema drives
> validation (Zod) on the client and the server, and PII/GDPR handling. This is the subject of the whole
> document.

## 2. The schema — a typed spine, a JSONB bag, surfaces

The design avoids both extremes (hardcoded columns *and* a slow EAV soup). Two tables, one rule: **a small typed
spine stays as real columns; everything custom lands in a JSONB bag.** DDL:
[`0004_fields.sql`](../db/migrations/0004_fields.sql); ERD/summary [03 §4a](03-data-model.md).

### 2.1 Two tables

```
core.field_sets        — one per (tenant, subject): 'participant' | 'guardian' | 'enrollment'
core.field_definitions — the fields in a set (label, type, target, surfaces, storage, …); optionally per-course
```

`core.field_sets` groups by **subject** (`key` = `participant` | `guardian` | `enrollment`); `core.field_definitions`
holds each field, ordered by `display_order`, scoped to the whole tenant (`course_id IS NULL`) or to a single
course (`course_id` set). Both are tenant‑scoped (`tenant_id`) and RLS‑guarded (§9).

### 2.2 The spine‑vs‑custom hybrid

A field's `storage` decides where its **value** lives:

| `storage` | Where the value is read/written | Which fields | Why |
|---|---|---|---|
| `column` | a **real typed column** — `participants.full_name`, `participants.date_of_birth`, `enrollments.payment_status`, the guardian columns… (`column_name` names it) | **system** fields (`is_system=true`) | Indexing, RLS, age‑based matching, dedupe, domain logic — all need typed columns ([03 §4,§8](03-data-model.md)). |
| `jsonb` | the existing **`participants.custom` / `enrollments.custom`** JSONB bag (keyed by the field `key`) | **custom** fields (`is_system=false`) | Add/remove without a migration; no schema churn per tenant. |

So the schema is a **presentation + validation layer over the spine, plus a bag** — not an EAV explosion. The
spine is the handful of columns the domain genuinely reasons about; the bag is everything else. A field's
`key` is its stable machine identifier (`child_name`, `dob`, `guardian_email`, `payment_status`, `note`, or a
custom `allergies`), independent of its (relabelable) `label`.

### 2.3 The field‑definition shape (canonical)

Every definition row — and the kernel `FieldDefinition` type ([§3](#3-the-kernel-fields-module)) — carries:

| Column / field | Type | Meaning |
|---|---|---|
| `key` | text | stable machine key (`child_name`, `payment_status`, `allergies`); unique per `(tenant, set, course)`. |
| `label` | jsonb→`LocalizedString` | shown label, e.g. `{"cs":"Jméno dítěte","en":"Child's name"}`. **Relabelable.** |
| `help` | jsonb→`LocalizedString` | optional helper text under the input. |
| `type` | `field_type` | `text · textarea · email · phone · date · number · select · multiselect · boolean · segmented`. |
| `target` | `field_target` | which subject: `participant · guardian · enrollment`. |
| `required` | bool | gates submit (client + server). |
| `options` | jsonb | for `select/multiselect/segmented`: `[{ value, label:{cs,en} }]`. |
| `validation` | jsonb | `{ minLength, maxLength, min, max, regex, … }` → compiled into Zod (§5). |
| `displayOrder` | int | render order within the set (Settings reorder writes it). |
| `surfaces` | `field_surface[]` | where it shows: `admin_form · public_form · portal` (§4). |
| `isSystem` | bool | **system field** → relabel/toggle/reorder yes, **delete no**; `storage='column'`. |
| `storage` | `field_storage` | `column` (system spine) \| `jsonb` (custom bag) — §2.2. |
| `columnName` | text? | when `storage='column'`: `full_name` / `date_of_birth` / `payment_status` / … |
| `pii` | bool | drives export/erase + log redaction (§8). |
| `editableBy` | `'staff'\|'guardian'\|'both'` | who may edit the value (admin vs portal). |
| `source` | text | provenance: `'preset' \| 'tenant' \| 'plugin:<id>'` (§7). |
| `active` | bool | soft on/off without deleting (toggles visibility everywhere). |

### 2.4 Surface‑aware

Each field declares its `surfaces`. The **same** definition can appear on one, two, or all three surfaces — so
*Stav platby* is admin‑only (`{admin_form}`), *GDPR / contact* fields are public+admin, and a portal‑editable
*Telefon* is `{admin_form, portal}`. The three surfaces are §4; the rendering split is the `surface` argument to
`resolveFields` (§3).

### 2.5 Per‑course override

A definition with `course_id` set applies **only to that course** and layers over the tenant‑wide set: it can add
a course‑specific field (a swimming course's *Plavecká úroveň*), or override `required`/`label` for one course.
Resolution merges tenant‑wide (`course_id IS NULL`) with the course's rows, the course row winning on `key`
collision. This subsumes the legacy `course_field_assignments` (which could only *attach* a library field per
course, never relabel or re‑require it).

### 2.6 Plugin‑contributed

A plugin may register field definitions with `source = 'plugin:<id>'`. The canonical example: the **`payments`
plugin contributes `payment_status`** to the `enrollment` set (the modal's *Stav platby*). When the plugin is
disabled the field is hidden; when enabled and entitled it appears. This is the field‑schema face of the Plugin
SDK's "fields" seam, complementing the `enrollment.form.extra` UI slot ([02 §12](02-reservation-core.md),
[09](09-plugins-and-subscriptions.md)).

## 3. The kernel `fields` module

The capability is **generic → it lives in the kernel** (`@tenantkit/kernel` `fields`, [02 §3](02-reservation-core.md)):
definitions, preset application, Zod + form‑descriptor generation, and value read/write across the spine + JSONB.
The participant/guardian/enrollment **presets** are the Termínář *app's* data (§10). The module's public API
(exact names — a sibling agent implements these):

```ts
// @tenantkit/kernel  (fields)

// types
type LocalizedString = Record<string, string>            // { cs, en, … }
type FieldType   = 'text'|'textarea'|'email'|'phone'|'date'|'number'|'select'|'multiselect'|'boolean'|'segmented'
type FieldTarget = 'participant'|'guardian'|'enrollment'
type FieldSurface = 'admin_form'|'public_form'|'portal'
type FieldStorage = 'column'|'jsonb'

interface FieldDefinition {
  key: string
  label: LocalizedString
  help?: LocalizedString
  type: FieldType
  target: FieldTarget
  required: boolean
  options?: Array<{ value: string; label: LocalizedString }>
  validation?: { minLength?: number; maxLength?: number; min?: number; max?: number; regex?: string }
  displayOrder: number
  surfaces: FieldSurface[]
  isSystem: boolean
  storage: FieldStorage
  columnName?: string                                    // when storage === 'column'
  pii: boolean
  editableBy: 'staff'|'guardian'|'both'
  source: string                                         // 'preset' | 'tenant' | 'plugin:<id>'
  active: boolean
}
interface FieldSet    { key: FieldTarget; name: LocalizedString; fields: FieldDefinition[] }
interface FieldPreset { key: string; name: LocalizedString; sets: FieldSet[] }   // e.g. 'kids-course' | 'adult'

// functions
applyPreset(preset: FieldPreset, tenantId: string): Promise<void>            // seed a tenant from an app preset (§10)
resolveFields(fields: FieldDefinition[], opts: { surface: FieldSurface }): FieldDefinition[]  // filter active + surface, sort
buildZodSchema(fields: FieldDefinition[]): ZodObject                          // → the validator (client + server, §5)
buildFormDescriptor(fields: FieldDefinition[], locale: string): FormDescriptor // → a renderable, localized form spec
splitValues(fields: FieldDefinition[], values: Record<string, unknown>):     // partition a submission for persistence
  { columns: Record<string, unknown>; custom: Record<string, unknown> }      //   columns→spine, custom→jsonb bag
mergeValues(...): Record<string, unknown>                                     // inverse: spine columns + jsonb bag → one value map for editing
```

- **`resolveFields`** is the surface filter: drop `active=false`, keep rows whose `surfaces` include the requested
  surface, sort by `displayOrder`. The admin modal asks for `admin_form`, the QR form for `public_form`, the
  portal for `portal`.
- **`buildZodSchema`** compiles each field's `type` + `required` + `validation` into a Zod object — the **single
  source** validated on both client and server (§5).
- **`buildFormDescriptor`** turns the resolved fields into a localized, renderable spec (labels/help picked for
  `locale`, options expanded, input kind per `type`) the React form layer renders — no per‑app form code.
- **`splitValues`** partitions a validated submission by `storage`: `column` fields → `columns` (keyed by
  `columnName`, written to the spine), `jsonb` fields → `custom` (keyed by `key`, written to the bag).
  **`mergeValues`** is the inverse, for loading a record into the edit form.

### 3.1 A tiny worked example — render then save

The *Nový účastník* modal end‑to‑end, with the kids preset resolved for one tenant:

```ts
// 1) load the tenant's definitions (participant ∪ guardian ∪ enrollment sets), then resolve for the surface
const admin = resolveFields(defs, { surface: 'admin_form' })       // Jméno dítěte, Datum narození, Zákonný zástupce,
                                                                   //   E-mail, Telefon, Kurz, Stav platby, Poznámka

// 2) build the validator + the renderable form, once
const schema     = buildZodSchema(admin)                           // used by the client form AND the route body (§5)
const descriptor = buildFormDescriptor(admin, ctx.locale)          // the React form renders this; no hardcoded fields

// 3) on submit: validate (same schema), then partition for persistence
const values = schema.parse(formState)                             // throws ZodError → 400 VALIDATION_ERROR
const { columns, custom } = splitValues(admin, values)
//   columns = { full_name, date_of_birth, payment_status, note, … }   → participants.* / enrollments.*
//   custom  = { allergies, swim_level, … }                            → participants.custom / enrollments.custom

await createParticipantAndEnrollment(ctx, { columns, custom })     // the staff-enroll use-case (doc 07 §5)
```

The `editableBy`‑split routes `target='guardian'` columns to the guardian record and `target='enrollment'`
columns (e.g. `payment_status`) to the enrollment — the use‑case fans `columns` out by `target`. Loading an
existing participant to edit runs `mergeValues` to reconstruct `formState` from the spine + bag.

## 4. The three surfaces, one field set

All three forms are the **same field set, filtered by surface** — never three hand‑written forms. This is the
payoff: relabel *Jméno dítěte* once and it changes everywhere it shows.

| Surface | `surface` | Who | What it shows | Doc |
|---|---|---|---|---|
| **Admin** *Nový účastník* modal | `admin_form` | staff (`editableBy` staff/both) | full set incl. admin‑only (*Stav platby*, *Poznámka*) | [07 §5](07-registration-and-enrollment.md) |
| **Public** QR form | `public_form` | anon | the contact + child fields + GDPR; never admin‑only | [07 §2,§7](07-registration-and-enrollment.md) |
| **Portal** | `portal` | guardian (`editableBy` guardian/both) | the family‑editable subset of their participant/guardian fields | [05](05-auth.md), portal |

### 4.1 The screenshot, mapped (kids preset → system spine)

The eight *Nový účastník* fields map to the **system spine** (all `isSystem=true`, `storage='column'`) plus their
`target` and `surfaces`. This *is* the default `kids-course` preset:

| Modal field (CZ) | `key` | `type` | `target` | `storage` → `columnName` | `surfaces` | `pii` |
|---|---|---|---|---|---|---|
| Jméno dítěte | `child_name` | `text` | participant | column → `full_name` | admin, public | ✔ |
| Datum narození | `dob` | `date` | participant | column → `date_of_birth` | admin, public | ✔ |
| Zákonný zástupce | `guardian_name` | `text` | guardian | column → `full_name` (guardian) | admin, public | ✔ |
| E‑mail | `guardian_email` | `email` | guardian | column → `email` | admin, public | ✔ |
| Telefon | `guardian_phone` | `phone` | guardian | column → `phone` | admin, public, portal | ✔ |
| Kurz | `course` | `select` | enrollment | column → `course_id` | admin | — |
| Stav platby | `payment_status` | `segmented` | enrollment | column → `payment_status` | admin | — |
| Poznámka | `note` | `textarea` | participant | column → `note` | admin | — |

*Stav platby* renders **Zaplaceno / Nezaplaceno** (the `segmented` two‑option control; options
`[{value:'paid',label:{cs:'Zaplaceno'}},{value:'unpaid',label:{cs:'Nezaplaceno'}}]`) and is **contributed by the
`payments` plugin** (`source='plugin:payments'`) — present only when payments is enabled+entitled, otherwise the
enrollment defaults to `payment_status='none'` ([03 §5](03-data-model.md), [09 §5](09-plugins-and-subscriptions.md)).
*Kurz* maps to the target `course_id` and is admin‑only (the public funnel picks the course in its own Step 2,
[07 §2](07-registration-and-enrollment.md)).

### 4.2 The contrast — the `adult` preset (per‑app)

The same three surfaces under the `adult` preset show a **different** form, with **no code change** — just a
different seeded set:

| Field (CZ) | `key` | `target` | Note |
|---|---|---|---|
| Jméno účastníka | `full_name` | participant | the participant *is* the adult; *child* relabeled away |
| E‑mail | `email` | participant | on the **participant**, not a guardian |
| Telefon | `phone` | participant | — |
| Kurz | `course` | enrollment | — |
| Stav platby | `payment_status` | enrollment | (if `payments` on) |
| Poznámka | `note` | participant | — |

No *Zákonný zástupce*, no *Datum narození* required; the participant manages themselves via a `self`‑relation
participant account ([03 §3](03-data-model.md), [07 §6](07-registration-and-enrollment.md)). The two presets prove the
point: **one engine, two products, zero forked form code.**

## 5. Validation parity — one Zod schema, client + server

`buildZodSchema(fields)` is the **single** validator. The client form (the descriptor's inputs) and the server
route's `body` schema are **the same compiled object**, so a hand‑crafted POST cannot bypass the client gates —
the exact parity principle already used for the funnel's `emailSchema`/`czPhoneSchema`
([02 §6](02-reservation-core.md), [07 §3](07-registration-and-enrollment.md)).

| Field facet | → Zod |
|---|---|
| `type: email` / `phone` / `date` | the shared `emailSchema` / `czPhoneSchema` / `dateOnlySchema` primitives |
| `type: number` + `validation.min/max` | `z.number().min().max()` |
| `type: select`/`segmented` + `options` | `z.enum([...option values])` |
| `type: multiselect` | `z.array(z.enum(...))` |
| `type: boolean` | `z.boolean()` |
| `type: text`/`textarea` + `validation.minLength/maxLength/regex` | `z.string().min().max().regex()` |
| `required: false` | `.optional()` |

The route wires it the usual way — `route({ …, body: buildZodSchema(resolved) }, handler)` — so the modal's
*„Vyplňte jméno, zástupce a platný e‑mail."* gate and the server's `400 VALIDATION_ERROR` come from one place
([07 §5](07-registration-and-enrollment.md)). Per‑course resolution means the schema is built from the
course‑merged set when a course is in scope (§2.5).

## 6. Settings → Pole účastníka (the admin UI)

The admin surface where a tenant **edits its own form**. A page per subject (Účastník / Zákonný zástupce / Zápis),
each a reorderable list of its fields with a *Přidat pole* action and a per‑field editor. The guardrails are the
crux — **system fields are protected, custom fields are free**:

| Operation | System field (`isSystem=true`) | Custom field (`isSystem=false`) |
|---|---|---|
| **Relabel** (`label`, `help`) | ✔ | ✔ |
| **Toggle on/off** (`active`) | ✔ (hide from forms; spine column stays) | ✔ |
| **Reorder** (`displayOrder`) | ✔ | ✔ |
| **Required ↔ optional** (`required`) | ✔ | ✔ |
| **Change `surfaces`** | ✔ | ✔ |
| **Edit `type` / `options`** | ✖ (bound to the typed column) | ✔ |
| **Create** | — (system fields are seeded, not authored) | ✔ (full CRUD) |
| **Delete** | ✖ **— the spine column stays for indexing/RLS/age/dedupe** | ✔ |
| **Per‑course override** | ✔ (relabel/require for one course) | ✔ (add a course‑only field) |

So you **can** relabel *Jméno dítěte* → *Jméno účastníka*, make *Telefon* optional, hide *Poznámka*, reorder, and
add *Alergie*; you **cannot** delete *Jméno* or repoint *Stav platby* to a `text` box — those are the spine.
Writes are admin‑only (`settings:manage`, RLS §9); deleting a custom field offers *„skrýt místo smazání"* (toggle
`active`) so historical values in the JSONB bag survive. Plugin‑contributed fields (`source='plugin:<id>'`) are
shown read‑only with an *„spravováno pluginem"* note — relabelable but not deletable here.

## 7. PII / GDPR

Each definition carries a **`pii`** flag, which is the field schema's contribution to the GDPR machinery
([03 §10](03-data-model.md)):

- **Export** (`GET /api/portal/account/export`) walks the field sets and includes every value — spine + bag —
  labeled by its localized `label`, so a subject‑access export is complete and human‑readable without hardcoding
  the field list.
- **Erase / anonymize** clears or tombstones values where `pii=true` (spine columns → null/"Smazáno", bag keys →
  removed), while non‑PII fields (e.g. *Plavecká úroveň*) may be retained for cohort stats — exactly the
  configurable anonymize policy of [03 §10](03-data-model.md).
- **Log redaction:** anything `pii=true` is redacted from structured logs / audit diffs (the "no PII in logs"
  rule, [01 §9](01-architecture.md)).
- **Consent** stays where it is (`gdpr_consent_at` on the application, [07 §3](07-registration-and-enrollment.md));
  the field schema describes *what* is collected, consent records *that it was agreed*.

A custom field handling personal data is simply created with `pii=true` in Settings, and it inherits all of the
above — no code change to extend GDPR coverage.

## 8. Presets & seeding a new tenant

A **`FieldPreset`** is an app‑shipped, named bundle of `FieldSet`s (the spine fields + sensible defaults).
Termínář ships two:

| Preset | `key` | Participant | Guardian set | For |
|---|---|---|---|---|
| **Kids' course** | `kids-course` | child (Jméno dítěte, Datum narození, Poznámka) | yes (Zákonný zástupce, E‑mail, Telefon) | swim/sport/music for children — the screenshot |
| **Adult** | `adult` | adult (Jméno účastníka, E‑mail, Telefon, Poznámka) | none (`self`) | adult fitness / language studios |

Provisioning a tenant calls **`applyPreset(preset, tenantId)`**, which inserts the preset's sets + definitions as
that tenant's `core.field_sets` / `core.field_definitions` with `source='preset'`. From that moment the tenant
**owns** its schema and edits it in Settings (§6) — later preset updates do **not** clobber tenant edits (preset
rows are a seed, not a live link). Tenant provisioning ([02 §8](02-reservation-core.md)) gains this one step;
which preset to apply is an app/onboarding choice (a swim school picks `kids-course`).

## 9. Storage, RLS & access

- **Read:** any tenant member may read the schema (every form needs it) — `field_sets_read` / `field_defs_read`
  via `core.is_member_of(tenant_id)`.
- **Write:** only admins (`settings:manage`) — `field_sets_write` / `field_defs_write` via
  `core.is_member_of(tenant_id,'admin')` (§6).
- **Public:** the QR form must render **before login**, so the `public_form`‑tagged, `active` rows are exposed
  read‑only to `anon` for `active` tenants — `field_defs_public`, mirroring the public‑catalogue policy
  ([03 §7](03-data-model.md)). Admin‑only fields (*Stav platby*, *Poznámka*) are never in that set, so the anon
  surface cannot learn them.
- **Values** live where `storage` says — the spine columns (already RLS‑guarded on `participants`/`enrollments`,
  [03 §7](03-data-model.md)) and the `custom` JSONB on the same rows; the field schema adds **no** value table,
  so no new value‑level RLS surface. Full policies: [`0004_fields.sql`](../db/migrations/0004_fields.sql).

## 10. Migration from the legacy `custom_field_definitions`

The unified model **supersedes** the legacy pair ([03 §4](03-data-model.md), [ADR‑0011](adr/0011-configurable-field-schema.md)):

| Legacy (`public.*`) | New (`core.*`) |
|---|---|
| `custom_field_definitions(name, field_type, allowed_values, display_order)` | rows in `core.field_definitions` with **`is_system=false`, `storage='jsonb'`, `source='tenant'`** |
| `field_type` enum `yes_no\|text\|options\|number\|date` | mapped to `field_type` (`yes_no→boolean`, `options→select` with `options` from `allowed_values`, others 1:1) |
| `course_field_assignments(course_id, field_id, required)` | a per‑course definition row (`course_id` set, `required` carried) — §2.5 |
| `participant_field_values(enrollment_id, field_id, value)` | values folded into `enrollments.custom` / `participants.custom` (JSONB), keyed by `key` |
| the **core** fields (hardcoded `child_name`, `dob`, …) | **new** system rows (`is_system=true`, `storage='column'`) the legacy model never had — the `kids-course` preset (§8) |

A one‑off migration script: for each tenant, (1) `applyPreset('kids-course')` to install the system spine, then
(2) translate each `custom_field_definition` into a `jsonb` custom definition (and its assignments into per‑course
overrides), then (3) backfill `participant_field_values` into the `custom` bags. After cut‑over the legacy tables
are dropped. The migration is listed as a Phase‑1/2 deliverable in [13 §3,§4](13-roadmap-and-milestones.md).

---

### Why this lives in the kernel (recap)

Every multi‑tenant SaaS that collects records about *people* wants exactly this — a relabelable, extendable,
surface‑aware form over a typed spine. So the **engine** (`fields` module: definitions, presets, Zod + descriptor
generation, spine/bag value split) is generic and ships in `@tenantkit/kernel` ([02 §3](02-reservation-core.md)),
while the **presets** (what a swim school vs. an adult studio collects) are the app's data. One more reason the
kernel is broadly useful beyond Termínář ([ADR‑0010](adr/0010-two-layer-packaging-and-oss-repos.md),
[ADR‑0011](adr/0011-configurable-field-schema.md)).
