-- 0004_fields.sql — configurable, surface-aware field schema (ADR-0011, docs/15-configurable-fields-and-settings.md).
--
-- WHY: every app/tenant has different participants. A kids' swim school needs "Jméno dítěte + Zákonný zástupce";
-- an adult fitness studio needs just "Jméno účastníka", no guardian. So the "Nový účastník" form, the public QR
-- form and the portal are DATA-DRIVEN from a per-tenant field schema, seeded from an app preset and editable in
-- Settings → Pole účastníka. This unifies + supersedes the older public.custom_field_definitions /
-- public.course_field_assignments (doc 03 §4): those become rows here with is_system=false.
--
-- Design: a small TYPED SPINE stays as real columns (full_name, date_of_birth, payment_status…) for indexing /
-- RLS / domain logic (age matching, dedupe). The schema below is a presentation+validation layer OVER that spine
-- plus a JSONB bag (participants.custom / enrollments.custom) for everything custom. NOT an EAV explosion.

create type field_type    as enum ('text','textarea','email','phone','date','number','select','multiselect','boolean','segmented');
create type field_target  as enum ('participant','guardian','enrollment');   -- which subject the field describes
create type field_storage as enum ('column','jsonb');                        -- system → typed column; custom → jsonb bag
create type field_surface as enum ('admin_form','public_form','portal');     -- where the field is shown

-- One set per subject per tenant: 'participant' | 'guardian' | 'enrollment'.
create table core.field_sets (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  key        text not null,                       -- subject key
  name       jsonb not null default '{}',         -- localized label, e.g. {"cs":"Účastník","en":"Participant"}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table core.field_definitions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  set_id        uuid not null references core.field_sets(id) on delete cascade,
  course_id     uuid references public.courses(id) on delete cascade,  -- null = whole tenant; set = only this course
  key           text not null,                    -- stable machine key: 'child_name','dob','guardian_email','payment_status','note'
  label         jsonb not null default '{}',      -- localized
  help          jsonb not null default '{}',      -- localized helper text
  type          field_type not null,
  target        field_target not null,
  required      boolean not null default false,
  options       jsonb not null default '[]',      -- select/segmented: [{ "value": "...", "label": {"cs":"…"} }]
  validation    jsonb not null default '{}',      -- { minLength, maxLength, min, max, regex, … }
  display_order int not null default 0,
  surfaces      field_surface[] not null default '{admin_form}',
  is_system     boolean not null default false,   -- system field: relabel/toggle/reorder yes, DELETE no
  storage       field_storage not null default 'jsonb',
  column_name   text,                             -- when storage='column' (e.g. 'full_name','date_of_birth','payment_status')
  pii           boolean not null default false,   -- drives export/erase + logging redaction
  editable_by   text not null default 'staff',    -- 'staff' | 'guardian' | 'both'
  source        text not null default 'tenant',   -- provenance: 'preset' | 'tenant' | 'plugin:<id>'
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, set_id, key, course_id)
);
create index on core.field_definitions (tenant_id, set_id, display_order);

create trigger trg_field_sets_updated        before update on core.field_sets        for each row execute function core.set_updated_at();
create trigger trg_field_definitions_updated before update on core.field_definitions for each row execute function core.set_updated_at();

-- RLS: any member reads the schema (forms need it); only admins (settings:manage) write it.
alter table core.field_sets        enable row level security;
alter table core.field_definitions enable row level security;

create policy field_sets_read  on core.field_sets        for select using (core.is_member_of(tenant_id));
create policy field_sets_write on core.field_sets        for all    using (core.is_member_of(tenant_id,'admin')) with check (core.is_member_of(tenant_id,'admin'));
create policy field_defs_read  on core.field_definitions for select using (core.is_member_of(tenant_id));
create policy field_defs_write on core.field_definitions for all    using (core.is_member_of(tenant_id,'admin')) with check (core.is_member_of(tenant_id,'admin'));

-- The public_form surface is read anonymously (the QR form must render before login). Exposed read-only,
-- only the public_form-tagged rows, for active tenants — mirrors the public catalogue policy (doc 03 §7).
create policy field_defs_public on core.field_definitions for select to anon
  using ('public_form' = any(surfaces) and active
         and exists (select 1 from core.tenants t where t.id = tenant_id and t.status = 'active'));
