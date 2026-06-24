# 03 — Data model

> The canonical schema. Names here are authoritative; other documents reference these tables and columns.
> Postgres on Supabase. `core.*` = framework schema (from `reservation-core`); `public.*` = the Termínář app
> domain; `payments.*`, `sms.*`, … = plugin schemas. Plugins reference app/core rows by id but never alter them.

## 1. Conventions

- **PKs**: `id uuid default gen_random_uuid()` for all domain rows. (Supabase `auth.users.id` is uuid; we
  align so joins are uniform. We deliberately drop the legacy apps' `bigint identity` mix.)
- **Tenant scoping**: every tenant‑owned table has `tenant_id uuid not null references core.tenants(id)`.
- **Timestamps**: `created_at timestamptz not null default now()`, `updated_at timestamptz not null default
  now()` maintained by the `core.set_updated_at()` BEFORE‑UPDATE trigger.
- **Soft delete**: `deleted_at timestamptz` where history matters (courses, credits); otherwise hard delete.
- **Enums**: Postgres enums for closed sets; prefixed (`course_status`, `attendance_state`, …).
- **Money**: never stored loose — the `payments` plugin owns money; the app stores only references + minor‑unit
  integer snapshots for display.
- **RLS**: enabled on **every** table; default deny. Predicates use `core.is_member_of()` /
  `core.guardian_can_act()` (§7) — never inline membership subqueries (avoids recursion + drift).

## 2. Entity‑relationship overview

```
                         core.tenants ──< core.memberships >── auth.users ──1:1── core.profiles
                              │  │                                  │
            ┌─────────────────┘  └───────────────┐                 └──< core.guardianships >── public.participants
            │                                     │                                                   │
   public.courses ──< public.sessions            core.plugin_activations                              │
        │   │              │                      core.plugin_settings                                 │
        │   │              │                                                                           │
        │   └──< public.course_tags               public.applications >───────────(approved)──────────┤
        │   └──< core.field_definitions >── core.field_sets  ▼   (configurable forms, §4a)            │
        │       (custom_field_definitions / course_field_assignments — SUPERSEDED, §4)                │
        │                                          public.enrollments >──────────────────────────────┘
        │                                                │
        ├──< public.validity_windows                     ├──< public.attendance (per session×participant)
        │                                                │         │ (state = excused)
        └── course.excuse_policy (embedded)              │         ▼
                                                         │   public.excuses ──issues──> public.credits
                                                         │                                   │ (redeem)
                                                         └──────────────< public.makeups <───┘
plugins:  payments.subscriptions / .orders / .payments     sms.messages / .templates
cross:    core.audit_log   core.email_events   core.tenant_domains   core.outbox
```

## 3. Core schema (`core.*`) — from `reservation-core`

### `core.tenants` — the studio/organization
```sql
create table core.tenants (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,                 -- public URL key; ‹slug›.terminar.cz
  name          text not null,
  status        tenant_status not null default 'active',   -- active | suspended
  default_locale text not null default 'cs',
  tier          text not null default 'free',         -- materialized subscription tier (payments plugin keeps fresh)
  branding      jsonb not null default '{}',          -- logo_url, colors, from_name, reply_to (white-label)
  settings      jsonb not null default '{}',          -- misc tenant prefs
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `core.profiles` — 1:1 with `auth.users`
```sql
create table core.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  locale      text,                                   -- per-user override of tenant default
  phone       text,
  avatar_url  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `core.memberships` — staff ↔ tenant ↔ role
```sql
create table core.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  role        app_role not null,                      -- staff | coach | admin | owner
  created_at timestamptz not null default now(),
  unique (user_id, tenant_id)
);
create unique index one_owner_per_tenant on core.memberships(tenant_id) where role = 'owner';
```
> Partial‑unique‑index trick (from Restaurio) enforces **exactly one owner per tenant**.

### `core.guardianships` — family account ↔ participant
```sql
create table core.guardianships (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,  -- the guardian account
  participant_id uuid not null references public.participants(id) on delete cascade,
  tenant_id     uuid not null references core.tenants(id),  -- denormalized for RLS speed
  relation      guardian_relation not null default 'parent', -- parent | guardian | self
  is_primary    boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, participant_id)
);
```
> A `self`‑relation row models an **adult participant managing themselves**. This pair — `participants` +
> `guardianships` — is the new identity modeling the legacy system lacked entirely.

### Plugin tables
```sql
create table core.plugin_activations (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  plugin_id text not null,
  is_enabled boolean not null default false,
  enabled_at timestamptz, disabled_at timestamptz,
  primary key (tenant_id, plugin_id)
);
create table core.plugin_settings (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  plugin_id text not null,
  settings  jsonb not null default '{}',
  primary key (tenant_id, plugin_id)
);
```

### Cross‑cutting
```sql
core.tenant_domains(id, tenant_id, host unique, verified_at)         -- custom domains (paid)
core.audit_log(id, tenant_id, actor_user_id, action, entity, entity_id, before jsonb, after jsonb, at)
core.email_events(id, tenant_id, resend_id, to, template, status, at)  -- delivery status from Resend webhook
core.outbox(id, tenant_id, event_type, payload jsonb, created_at, processed_at)  -- domain-event fanout to plugins
```

## 4. Course domain (`public.*`)

### `public.participants` — the person attending
```sql
create table public.participants (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  full_name   text not null,
  date_of_birth date,                                  -- drives age-based course matching
  note        text,                                    -- staff note (the profile modal's textarea)
  custom      jsonb not null default '{}',             -- denormalized snapshot of custom field values
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```
> Age (in months for babies, years for kids) is **computed from `date_of_birth`**, never stored — matches the
> QR form's behavior.

### `public.courses` — the long‑term offering ("kurz")
```sql
create table public.courses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  title         text not null,
  description   text,
  kind          course_kind not null default 'multi_session',  -- one_time | multi_session
  status        course_status not null default 'draft',        -- draft | active | completed | cancelled
  capacity      int not null check (capacity >= 1),
  age_min_months int, age_max_months int,             -- nullable age band for auto-matching
  registration_mode reg_mode not null default 'open', -- open | staff_only
  show_on_public boolean not null default false,      -- listed on the public catalogue?
  -- excuse / omluvenka policy (see doc 08):
  excuse_policy jsonb not null default '{}',           -- { creditsEnabled, expiry:{mode,…}, deadlineHours, tags[] }
  primary_coach_id uuid references auth.users(id),
  created_by    uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
```

### `public.sessions` — one lesson ("lekce")
```sql
create table public.sessions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  starts_at   timestamptz not null,
  duration_min int not null check (duration_min >= 1),
  location    text,
  sequence    int not null,                            -- 1-based order within the course
  capacity_override int,                               -- null → inherit course.capacity
  status      session_status not null default 'scheduled', -- scheduled | cancelled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.sessions(course_id, starts_at);
```
> **No recurrence rule is stored** — the recurrence generator (doc 06) emits an explicit, editable list of
> sessions. This is a deliberate carry‑over from legacy: it handles holidays/exceptions cleanly.

### Supporting tables
```sql
public.course_tags(course_id, tag)                     -- freeform tags; used by credit redemption matching
public.coach_assignments(course_id, user_id, is_primary)  -- coaches on a course (own-scope RLS)
public.validity_windows(id, tenant_id, name, starts_on date, ends_on date, deleted_at)  -- named expiry windows
public.custom_field_definitions(id, tenant_id, name, field_type, allowed_values text[], display_order)
public.course_field_assignments(course_id, field_id, required boolean)
```
`field_type` enum: `yes_no | text | options | number | date`.

> **Superseded.** `public.custom_field_definitions` / `public.course_field_assignments` (and the per‑enrollment
> `participant_field_values`, §5) are **replaced** by the unified, surface‑aware field schema
> `core.field_sets` + `core.field_definitions` (§4a below, [migration 0004](../supabase/migrations/0004_fields.sql),
> [ADR‑0011](adr/0011-configurable-field-schema.md)). They survive only as a **migration source** ([15 §10](15-configurable-fields-and-settings.md))
> and are dropped after cut‑over. New work targets the unified model.

### 4a. Configurable field schema (`core.*`) — the data‑driven forms

The *"Nový účastník"* modal, the public QR form, and the portal are **not hardcoded** — they render from a
per‑tenant, surface‑aware field schema, so a swim school collects *Jméno dítěte + Zákonný zástupce* while an
adult studio collects only *Jméno účastníka*. A small **typed spine** (`participants.full_name`,
`date_of_birth`, `note`; `enrollments.payment_status`; the guardian columns) stays as real columns for indexing /
RLS / age‑matching / dedupe; everything custom lands in the `participants.custom` / `enrollments.custom` JSONB
bags. **Authority:** [15](15-configurable-fields-and-settings.md); **DDL:** [migration 0004](../supabase/migrations/0004_fields.sql).

```sql
-- one set per subject per tenant: 'participant' | 'guardian' | 'enrollment'
create table core.field_sets (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  key        text not null,                       -- subject key
  name       jsonb not null default '{}',         -- localized label {"cs":…,"en":…}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table core.field_definitions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  set_id      uuid not null references core.field_sets(id) on delete cascade,
  course_id   uuid references public.courses(id) on delete cascade,  -- null = whole tenant; set = only this course
  key         text not null,                       -- stable machine key: 'child_name','dob','guardian_email','payment_status','note'
  label       jsonb not null default '{}',         -- localized; relabelable
  help        jsonb not null default '{}',         -- localized helper text
  type        field_type not null,                 -- text|textarea|email|phone|date|number|select|multiselect|boolean|segmented
  target      field_target not null,               -- participant | guardian | enrollment
  required    boolean not null default false,
  options     jsonb not null default '[]',         -- select/segmented: [{value,label:{…}}]
  validation  jsonb not null default '{}',         -- {minLength,maxLength,min,max,regex,…} → compiled to Zod
  display_order int not null default 0,
  surfaces    field_surface[] not null default '{admin_form}',  -- admin_form | public_form | portal
  is_system   boolean not null default false,      -- system field: relabel/toggle/reorder yes, DELETE no
  storage     field_storage not null default 'jsonb',           -- system → 'column'; custom → 'jsonb'
  column_name text,                                 -- when storage='column' ('full_name','date_of_birth','payment_status'…)
  pii         boolean not null default false,       -- export/erase + log redaction
  editable_by text not null default 'staff',        -- 'staff' | 'guardian' | 'both'
  source      text not null default 'tenant',       -- 'preset' | 'tenant' | 'plugin:<id>'
  active      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, set_id, key, course_id)
);
create index on core.field_definitions (tenant_id, set_id, display_order);
```

- **Spine vs. bag:** `storage='column'` fields (always `is_system=true`) read/write a typed column named by
  `column_name`; `storage='jsonb'` (custom) fields read/write the `custom` bag keyed by `key`. **Not EAV** — no
  per‑value table, so no new value‑level RLS surface.
- **Surface‑aware:** `surfaces` declares where a field shows (`admin_form` / `public_form` / `portal`); one
  definition can serve all three ([15 §4](15-configurable-fields-and-settings.md)).
- **Per‑course override** (`course_id` set) and **plugin‑contributed** (`source='plugin:<id>'`, e.g. `payments`
  → `payment_status`) layer over the tenant‑wide set ([15 §2.5,§2.6](15-configurable-fields-and-settings.md)).
- **Enums:** `field_type`, `field_target`, `field_storage`, `field_surface` (DDL in 0004).
- **RLS:** members read; admins (`settings:manage`) write; `public_form`‑tagged active rows read‑only to `anon`
  for active tenants — see §7 and [15 §9](15-configurable-fields-and-settings.md).
- **Presets & seeding:** a new tenant is seeded from an app preset (`kids-course` / `adult`) via the kernel
  `fields` module's `applyPreset` ([15 §8](15-configurable-fields-and-settings.md), [02 §3](02-reservation-core.md)).

## 5. Enrollment domain

### `public.applications` — a submitted public form ("přihláška")
```sql
create table public.applications (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  course_id     uuid references public.courses(id),    -- requested course (may be re-assigned on approval)
  desired_session_id uuid references public.sessions(id),
  -- captured contact (no account required yet):
  child_name    text not null,
  child_dob     date,
  guardian_name text not null,
  guardian_email text not null,
  guardian_phone text,
  source        text,                                  -- "how did you hear about us"
  custom        jsonb not null default '{}',           -- custom field answers
  gdpr_consent_at timestamptz not null,
  status        application_status not null default 'pending',  -- pending | approved | rejected
  safe_link_token uuid not null default gen_random_uuid(),      -- emailed confirm/track link
  decided_by    uuid references auth.users(id),
  decided_at    timestamptz,
  created_at timestamptz not null default now()
);
```

### `public.enrollments` — confirmed participant ↔ course ("zápis")
```sql
create table public.enrollments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  course_id     uuid not null references public.courses(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  source        enrollment_source not null,            -- application | staff | makeup
  application_id uuid references public.applications(id),
  status        enrollment_status not null default 'active',  -- active | cancelled | completed
  payment_status payment_state not null default 'none', -- none | unpaid | paid | waived | refunded (payments plugin updates)
  enrolled_at timestamptz not null default now(),
  cancelled_at timestamptz, cancel_reason text,
  unique (course_id, participant_id) where status = 'active'   -- no double active enrollment
);
public.participant_field_values(enrollment_id, field_id, value text)  -- per-enrollment custom answers (SUPERSEDED §4a → enrollments.custom)
```
> Custom answers now live in the `enrollments.custom` / `participants.custom` JSONB bags, keyed by field `key`,
> per the unified field schema (§4a, [15](15-configurable-fields-and-settings.md)); `participant_field_values`
> is a migration source only.

## 6. Attendance & omluvenky (`public.*`) — see doc 08 for the logic

### `public.attendance`
```sql
create table public.attendance (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  session_id    uuid not null references public.sessions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  enrollment_id uuid references public.enrollments(id),
  state         attendance_state not null,             -- present | excused | absent | unmarked
  marked_by     uuid references auth.users(id),
  marked_at     timestamptz not null default now(),
  unique (session_id, participant_id)
);
```

### `public.excuses` — the act of excusing ("omluvení")
```sql
create table public.excuses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  session_id    uuid not null references public.sessions(id),
  participant_id uuid not null references public.participants(id),
  enrollment_id uuid references public.enrollments(id),
  source        excuse_source not null default 'staff',  -- staff (attendance) | self (portal, before deadline)
  status        excuse_status not null default 'recorded', -- recorded | credit_issued
  credit_id     uuid references public.credits(id),
  created_at timestamptz not null default now(),
  unique (session_id, participant_id)
);
```

### `public.credits` — the makeup credit ("omluvenka")
```sql
create table public.credits (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  source_excuse_id uuid references public.excuses(id),
  source_course_id uuid references public.courses(id),
  source_session_id uuid references public.sessions(id),
  tags          text[] not null default '{}',          -- copied from source course at issue time (redemption matching)
  -- EXPIRY (per-course policy; doc 08):
  expires_at    timestamptz,                            -- simple TTL mode (null = governed by windows or never)
  valid_window_ids uuid[] not null default '{}',        -- advanced mode: redeemable within these windows
  status        credit_status not null default 'active', -- active | redeemed | expired | cancelled
  redeemed_makeup_id uuid references public.makeups(id),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz, deleted_at timestamptz
);
public.credit_audit(id, credit_id, actor_user_id, action, field, before, after, at)  -- append-only (extend/retag/cancel)
```

### `public.makeups` — a session booked with a credit ("náhrada")
```sql
create table public.makeups (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  credit_id     uuid not null references public.credits(id),
  participant_id uuid not null references public.participants(id),
  session_id    uuid not null references public.sessions(id),  -- the makeup target
  status        makeup_status not null default 'booked',       -- booked | cancelled | attended
  booked_by     uuid references auth.users(id),                -- guardian or staff
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);
```

## 7. Multi‑tenancy & RLS

**Every table** has RLS enabled. Three predicate families cover all cases:

```sql
-- 1) Staff access to tenant-owned rows (read = any member, write = role-gated):
create policy staff_read  on public.courses for select using (core.is_member_of(tenant_id));
create policy staff_write on public.courses for all
  using (core.is_member_of(tenant_id, 'coach')) with check (core.is_member_of(tenant_id, 'coach'));

-- 2) Family access to a participant's rows (guardian can act for their participants):
create policy family_read on public.credits for select
  using (core.guardian_can_act(participant_id));

-- 3) Public reads (catalogue, slot availability) for the anon role, gated by a flag:
create policy public_catalogue on public.courses for select
  to anon using (show_on_public and status = 'active');
```

Key rules (lessons baked in):

- **`core.is_member_of()` is `SECURITY DEFINER`** so a policy on `memberships` that needs to read
  `memberships` does **not** recurse (Restaurio hit exactly this "infinite recursion in policy" bug).
- **`memberships` own policies are self‑row only** (`user_id = auth.uid()`); cross‑member admin reads go through
  `SECURITY DEFINER` RPCs or the service‑role client (re‑checking authorization in code).
- **Family RLS** uses `core.guardian_can_act(participant_id)` = `exists(select 1 from core.guardianships g where
  g.participant_id = $1 and g.user_id = auth.uid())`, also `SECURITY DEFINER`.
- **Atomic capacity**: enrolling / booking a makeup goes through a `SECURITY DEFINER` RPC that does
  `select … for update` on the target session's counted rows before inserting — preventing overbooking under
  concurrency (generalized from `main-panel`'s `marketplace_create_booking` + waitlist promotion). See doc 08.

## 8. Indexing (the hot paths)

- `memberships(user_id)`, `memberships(tenant_id)`, `guardianships(user_id)`, `guardianships(participant_id)`.
- `sessions(course_id, starts_at)`, `sessions(tenant_id, starts_at)` (calendar & availability).
- `attendance(session_id)`, `attendance(participant_id)`.
- `credits(participant_id) where status='active'` (portal balance), `credits(tenant_id, status)`.
- `applications(tenant_id, status)`, `enrollments(course_id) where status='active'` (capacity).
- partial‑unique `enrollments(course_id, participant_id) where status='active'`.

## 9. Plugin schemas (illustrative)

Plugins own their schema; they read core/app rows by id. Examples:

```sql
-- payments plugin
payments.subscriptions(id, tenant_id, stripe_subscription_id, tier, status, current_period_end)  -- tenant billing
payments.orders(id, tenant_id, enrollment_id, amount_minor, currency, status, stripe_checkout_id)
payments.payments(id, order_id, stripe_payment_intent, status, paid_at)

-- sms plugin
sms.messages(id, tenant_id, to_phone, template, body, status, provider_ref, sent_at)
sms.templates(tenant_id, key, locale, body)
```

The `payments` plugin's webhooks update `core.tenants.tier` (tenant subscription) and
`public.enrollments.payment_status` (course payment) — through documented application calls, not raw writes.

## 10. Data lifecycle & GDPR

- **Consent** captured on the application (`gdpr_consent_at`) and surfaced in the participant record.
- **Export**: `GET /api/portal/account/export` assembles a guardian's + participants' data (JSON).
- **Erase**: account deletion cascades guardianships; participants with history are anonymized (name → "Smazáno",
  keep aggregate attendance counts) rather than hard‑deleted where a tenant needs cohort stats — configurable.
- **Retention**: applications rejected > N months and unredeemed expired credits are purged by a scheduled job.

See the sample migration in [`supabase/migrations/`](../supabase/migrations/) for the concrete RLS recipe.
