-- ILLUSTRATIVE MOCKUP — realizes docs/09-plugins-and-subscriptions.md §6.4 and docs/03-data-model.md §9.
--
-- The SMS plugin owns the `sms` schema and NOTHING else (doc 09 §1, §8): it may reference core/app rows by id
-- (tenant_id → core.tenants) but may never ALTER core.* / public.*. CI fails the build if any statement here
-- targets a reserved schema (doc 09 §8 denylist). RLS is on every table; tenant isolation reuses
-- core.is_member_of() (the SAME predicate the app uses) so there is no second membership check to drift.
--
-- Apply AFTER the core + app migrations (supabase/migrations/0001_core.sql defines core.is_member_of()).

create schema if not exists sms;

-- ── enums ───────────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type sms.message_status as enum ('queued', 'sent', 'delivered', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sms.provider as enum ('twilio', 'smsbrana');
exception when duplicate_object then null; end $$;

-- ── sms.templates — per tenant, localized (key × locale), seeded on onEnable (doc 09 §2.3, §6.4) ─────────────
create table if not exists sms.templates (
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  key        text not null,                       -- 'session_reminder' | 'credit_issued' | …
  locale     text not null,                       -- 'cs' | 'en'
  body       text not null,                        -- {{var}} interpolation, same contract as email (doc 09 §6.4)
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key, locale)
);

-- ── sms.messages — one row per send; status + cost for the admin "Náklady" panel (doc 09 §6.3, §6.4) ────────
create table if not exists sms.messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  to_phone      text not null,                     -- E.164
  template      text not null,
  locale        text not null,
  body          text not null,                     -- rendered copy actually sent
  status        sms.message_status not null default 'queued',
  provider      sms.provider,
  provider_ref  text,                              -- gateway message id (returned by SmsProvider.send)
  cost_minor    int,                               -- minor units, for monthly spend aggregation
  error         text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists sms_messages_tenant_created on sms.messages (tenant_id, created_at desc);

-- updated_at maintenance on templates (the core trigger fn, doc 03 §1).
drop trigger if exists set_updated_at on sms.templates;
create trigger set_updated_at before update on sms.templates
  for each row execute function core.set_updated_at();

-- ── RLS — default deny; tenant isolation via core.is_member_of() (doc 03 §7, doc 09 §6) ─────────────────────
alter table sms.templates enable row level security;
alter table sms.messages  enable row level security;

-- Templates: any member reads; admin+ edits (settings-class data, doc 04 §3 settings:manage).
create policy sms_templates_read on sms.templates
  for select using (core.is_member_of(tenant_id));
create policy sms_templates_write on sms.templates
  for all
  using      (core.is_member_of(tenant_id, 'admin'))
  with check (core.is_member_of(tenant_id, 'admin'));

-- Messages: any member may read the log; rows are WRITTEN by the dispatcher via the plugin's schema-scoped
-- service-role client (doc 09 §7), which bypasses RLS — so there is no INSERT policy for ordinary callers.
create policy sms_messages_read on sms.messages
  for select using (core.is_member_of(tenant_id));
