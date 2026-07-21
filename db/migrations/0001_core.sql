-- ILLUSTRATIVE MOCKUP — realizes docs/03-data-model.md §3 (core schema) + §7 (RLS) + docs/04 §1,§5,§7 +
-- docs/02-reservation-core.md §14 (the SQL building blocks `@reservation-core/db` ships).
--
-- Schema `core` = the framework schema (product-agnostic: tenants, members, roles, plugins, email, outbox).
-- Migration 0001 of 3: core first, then 0002_courses (public.*), then 0003_omluvenky (public.* + the redeem RPC).
--
-- THE load-bearing lesson baked in here (doc 03 §7, doc 04 §4): the membership predicate is ONE
-- SECURITY DEFINER function `core.is_member_of()`; policies call it instead of an inline subquery, so a policy
-- ON core.memberships that must READ core.memberships does NOT recurse (the "infinite recursion in policy" bug
-- Restaurio hit). RLS is enabled on EVERY table; default deny.

create schema if not exists core;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ enums                                                                                                      │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
-- NOTE: member roles are NOT an enum — the framework does not own the role vocabulary. Each app declares its own
-- roles as DATA in `core.roles` (below) + `defineRoles()` at boot, so a project's roles never leak into the core.
do $$ begin create type core.tenant_status      as enum ('active', 'suspended');                     exception when duplicate_object then null; end $$;
do $$ begin create type core.participant_relation as enum ('parent', 'guardian', 'self');              exception when duplicate_object then null; end $$;
do $$ begin create type core.platform_role      as enum ('support', 'superadmin');                   exception when duplicate_object then null; end $$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ core.roles — the app's role vocabulary as DATA (replaces the hardcoded app_role enum, doc 17 §8).         │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
-- Seeded PER DEPLOYMENT by the app (its own migration, mirroring its `defineRoles()` call). The framework only
-- compares by `rank` and reads the capability flags `is_owner` (the single top principal) / `is_admin` (may
-- administer the tenant); the KEYS are entirely app-defined. Created before the functions that read it.
create table if not exists core.roles (
  key      text primary key,
  rank     int  not null,
  label    text,
  is_owner boolean not null default false,
  is_admin boolean not null default false
);
-- At most one owner role in the vocabulary (the per-tenant single-owner-MEMBERSHIP invariant is a trigger below).
create unique index if not exists roles_single_owner on core.roles ((is_owner)) where is_owner;
-- EXAMPLE app seed (the app owns this — override in your own migration to match your defineRoles()):
--   insert into core.roles (key, rank, label, is_owner, is_admin) values
--     ('member', 1, 'Member', false, false),
--     ('manager', 2, 'Manager', false, true),
--     ('owner',  3, 'Owner',  true,  true);

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ functions — the @reservation-core/db building blocks (doc 02 §14). Created BEFORE the policies use them.   │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯

-- The PORTABILITY seam (doc 14 §3.1): the caller's id, resolved from EITHER the Supabase/PostgREST
-- request.jwt.claims GUC OR a plain app.user_id GUC a direct-driver adapter sets with SET LOCAL. EVERY predicate
-- below calls THIS — never a vendor's auth.uid() — so the IDENTICAL RLS runs on Supabase, Neon, RDS, or a laptop
-- Postgres. An adapter MAY override it (the Supabase adapter ships `... as $$ select auth.uid() $$`, optional).
create or replace function core.current_user_id()
  returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub',  -- Supabase / PostgREST path
    nullif(current_setting('app.user_id', true), '')                          -- direct-driver path (SET LOCAL)
  )::uuid
$$;

-- Rank of a role — a lookup into the app-seeded core.roles (0 for unknown). Ranks match the app's defineRoles().
-- STABLE (not immutable): it reads a table.
create or replace function core.role_rank(p_role text)
  returns int language sql stable
  set search_path = core, public as $$
  select coalesce((select rank from core.roles where key = p_role), 0)
$$;

-- THE membership predicate. SECURITY DEFINER + STABLE → reads core.memberships without recursing (doc 03 §7).
-- p_min_role null ⇒ ANY member (no minimum). A role key ⇒ rank-compared via core.role_rank.
create or replace function core.is_member_of(p_tenant uuid, p_min_role text default null)
  returns boolean language sql security definer stable
  set search_path = core, public as $$
  select exists (
    select 1 from core.memberships m
    where m.tenant_id = p_tenant
      and m.user_id   = core.current_user_id()
      and (p_min_role is null or core.role_rank(m.role) >= core.role_rank(p_min_role))
  )
$$;

-- Capability predicates for framework-CORE policies, decoupled from role NAMES (doc 04 §6). The app maps its roles
-- to these via core.roles.is_owner / is_admin. "owner" = the single top principal; "admin" = may administer the tenant.
create or replace function core.is_owner(p_tenant uuid)
  returns boolean language sql security definer stable
  set search_path = core, public as $$
  select exists (
    select 1 from core.memberships m join core.roles r on r.key = m.role
    where m.tenant_id = p_tenant and m.user_id = core.current_user_id() and r.is_owner
  )
$$;
create or replace function core.is_admin(p_tenant uuid)
  returns boolean language sql security definer stable
  set search_path = core, public as $$
  select exists (
    select 1 from core.memberships m join core.roles r on r.key = m.role
    where m.tenant_id = p_tenant and m.user_id = core.current_user_id() and r.is_admin
  )
$$;

-- The caller's own role in a tenant — SECURITY DEFINER companion to is_member_of (doc 04 §5, rank-cap checks).
create or replace function core.my_role(p_tenant uuid)
  returns text language sql security definer stable
  set search_path = core, public as $$
  select m.role from core.memberships m
  where m.tenant_id = p_tenant and m.user_id = core.current_user_id()
$$;

-- Participant-account predicate: may this account act for the participant? SECURITY DEFINER (doc 04 §7).
create or replace function core.can_act_for_participant(p_participant uuid)
  returns boolean language sql security definer stable
  set search_path = core, public as $$
  select exists (
    select 1 from core.participant_accounts pa
    where pa.participant_id = p_participant and pa.user_id = core.current_user_id()
  )
$$;

-- Cross-tenant platform-operator predicate — used ONLY by ops routes/policies, never mixed into tenant policies
-- (doc 04 §6). Kept here for completeness of the core surface.
create or replace function core.platform_rank(p_level text)
  returns int language sql immutable as $$
  select case p_level when 'superadmin' then 2 when 'support' then 1 else 0 end
$$;
create or replace function core.is_platform_admin(p_min text default 'support')
  returns boolean language sql security definer stable
  set search_path = core, public as $$
  select exists (
    select 1 from core.platform_admins pa
    where pa.user_id = core.current_user_id()
      and core.platform_rank(pa.level::text) >= core.platform_rank(p_min)
  )
$$;

-- BEFORE-UPDATE trigger fn to maintain updated_at (doc 03 §1). Attached per table below.
create or replace function core.set_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end;
$$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ tables                                                                                                     │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯

-- core.tenants — the studio/organization (doc 03 §3).
create table if not exists core.tenants (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,                       -- ‹slug›.terminar.cz
  name           text not null,
  status         core.tenant_status not null default 'active',
  default_locale text not null default 'cs',
  tier           text not null default 'free',               -- materialized by the payments plugin (doc 09 §3.3)
  branding       jsonb not null default '{}',                -- logo_url, colors, from_name, reply_to
  settings       jsonb not null default '{}',                -- incl. settings.excuseDefaults (doc 08 §12)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- core.profiles — 1:1 with the identity provider's user id; FK-less so any IdP works (doc 03 §3).
create table if not exists core.profiles (
  id         uuid primary key,
  full_name  text,
  locale     text,                                            -- per-user override of tenant default
  phone      text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- core.memberships — staff ↔ tenant ↔ role (doc 03 §3). `role` is an app-defined key from core.roles (not an enum).
create table if not exists core.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  role       text not null references core.roles(key),         -- app vocabulary (see core.roles)
  created_at timestamptz not null default now(),
  unique (user_id, tenant_id)
);
create index if not exists memberships_user_idx   on core.memberships(user_id);
create index if not exists memberships_tenant_idx on core.memberships(tenant_id);

-- EXACTLY one owner per tenant (doc 04 §2). The owner ROLE is app-defined (core.roles.is_owner), so this is a
-- trigger rather than a partial index on a literal role name. Promotion = transfer.
create or replace function core.enforce_single_owner()
  returns trigger language plpgsql
  set search_path = core, public as $$
  begin
    if exists (select 1 from core.roles where key = new.role and is_owner)
       and exists (
         select 1 from core.memberships m join core.roles r on r.key = m.role
         where m.tenant_id = new.tenant_id and r.is_owner and m.id <> new.id
       ) then
      raise exception 'tenant already has an owner' using errcode = '23505';
    end if;
    return new;
  end $$;
drop trigger if exists memberships_single_owner on core.memberships;
create trigger memberships_single_owner before insert or update on core.memberships
  for each row execute function core.enforce_single_owner();

-- core.participant_accounts — a user account ↔ the participant it may act for (doc 03 §3). participant_id FK added
-- in 0002 after the table exists; declared here without the cross-schema FK to keep migration order clean.
create table if not exists core.participant_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,                                              -- the linked user account
  participant_id uuid not null,                                              -- → public.participants(id) (0002)
  tenant_id      uuid not null references core.tenants(id),                  -- denormalized for RLS speed
  relation       core.participant_relation not null default 'self',         -- 'self' (adult/own) | app value e.g. 'guardian','parent'
  is_primary     boolean not null default true,
  created_by     uuid,                                                       -- who created the link (e.g. the invite's inviter)
  created_at     timestamptz not null default now(),
  unique (user_id, participant_id)
);
create index if not exists participant_accounts_user_idx        on core.participant_accounts(user_id);
create index if not exists participant_accounts_participant_idx on core.participant_accounts(participant_id);

-- Plugin tables (doc 03 §3).
create table if not exists core.plugin_activations (
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  plugin_id   text not null,
  is_enabled  boolean not null default false,
  enabled_at  timestamptz,
  disabled_at timestamptz,
  primary key (tenant_id, plugin_id)
);
create table if not exists core.plugin_settings (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  plugin_id text not null,
  settings  jsonb not null default '{}',
  primary key (tenant_id, plugin_id)
);

-- Cross-cutting (doc 03 §3).
create table if not exists core.tenant_domains (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  host        text not null unique,
  verified_at timestamptz
);
create table if not exists core.audit_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references core.tenants(id) on delete cascade,          -- null for cross-tenant ops (doc 04 §6)
  actor_user_id uuid,
  action        text not null,
  entity        text,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  at            timestamptz not null default now()
);
create table if not exists core.email_events (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete cascade,
  resend_id text,
  "to"      text,
  template  text,
  status    text,
  at        timestamptz not null default now()
);
-- Transactional outbox — domain-event fanout to plugins/email (doc 03 §3, doc 09 §5).
create table if not exists core.outbox (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references core.tenants(id) on delete cascade,
  event_type   text not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists outbox_unprocessed_idx on core.outbox(created_at) where processed_at is null;

-- In-app notifications (doc 03 §3 ER + doc 10).
create table if not exists core.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references core.tenants(id) on delete cascade,
  user_id    uuid not null,
  kind       text not null,
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

-- Platform operators — a SEPARATE grant table, deliberately NOT a high app_role (doc 04 §6).
create table if not exists core.platform_admins (
  user_id    uuid primary key,
  level      core.platform_role not null default 'support',
  created_at timestamptz not null default now()
);

-- The atomic provisioning RPC behind provisionTenant (doc 02 §8) — created after the tables it inserts into.
create or replace function core.create_tenant_with_owner(p_name text, p_slug text, p_owner uuid)
  returns uuid language plpgsql security definer
  set search_path = core, public as $$
  declare v_id uuid; v_owner text;
  begin
    select key into v_owner from core.roles where is_owner limit 1;
    if v_owner is null then raise exception 'no owner role defined in core.roles' using errcode = 'P0001'; end if;
    insert into core.tenants (name, slug) values (p_name, p_slug) returning id into v_id;
    insert into core.memberships (user_id, tenant_id, role) values (p_owner, v_id, v_owner);
    return v_id;
  end;
$$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ updated_at triggers                                                                                        │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
drop trigger if exists set_updated_at on core.tenants;
create trigger set_updated_at before update on core.tenants  for each row execute function core.set_updated_at();
drop trigger if exists set_updated_at on core.profiles;
create trigger set_updated_at before update on core.profiles for each row execute function core.set_updated_at();

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ RLS — enabled on EVERY table; default deny (doc 03 §7). Membership self-row policies avoid recursion.      │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
alter table core.tenants            enable row level security;
alter table core.profiles           enable row level security;
alter table core.memberships        enable row level security;
alter table core.participant_accounts enable row level security;
alter table core.plugin_activations enable row level security;
alter table core.plugin_settings    enable row level security;
alter table core.tenant_domains     enable row level security;
alter table core.audit_log          enable row level security;
alter table core.email_events       enable row level security;
alter table core.outbox             enable row level security;
alter table core.notifications      enable row level security;
alter table core.platform_admins    enable row level security;

-- tenants: a member reads their tenant; only admin+ may update its settings/branding (owner does billing/tier).
create policy tenants_read  on core.tenants for select using (core.is_member_of(id));
create policy tenants_write on core.tenants for update
  using (core.is_admin(id)) with check (core.is_admin(id));

-- profiles: a user sees/edits ONLY their own profile row (doc 02 §7 bootstrap).
create policy profiles_self_read   on core.profiles for select using (id = core.current_user_id());
create policy profiles_self_upsert on core.profiles for insert with check (id = core.current_user_id());
create policy profiles_self_update on core.profiles for update using (id = core.current_user_id()) with check (id = core.current_user_id());

-- memberships: SELF-ROW reads only (doc 03 §7, doc 04 §5) — cross-member admin reads go via SECURITY DEFINER
-- RPC / service role. Writes are rank-capped: an actor may target only a role strictly below their own, never
-- 'owner' (owner transfer is its own RPC). is_member_of()/my_role() are SECURITY DEFINER → no recursion.
create policy memberships_self_read on core.memberships for select using (user_id = core.current_user_id());
create policy memberships_manage on core.memberships for all
  using      (core.is_admin(tenant_id))
  with check (
    core.is_admin(tenant_id)
    and not exists (select 1 from core.roles where key = role and is_owner)
    and core.role_rank(role) < core.role_rank(core.my_role(tenant_id))
  );

-- participant_accounts: a user sees their own links; a tenant admin may read the tenant's links (support).
create policy participant_accounts_self_read on core.participant_accounts for select using (user_id = core.current_user_id());
create policy participant_accounts_admin_read on core.participant_accounts for select using (core.is_admin(tenant_id));

-- plugin activation/settings: admin+ manage (plugins:manage, doc 04 §3); any member may read which are on.
create policy plugin_activations_read  on core.plugin_activations for select using (core.is_member_of(tenant_id));
create policy plugin_activations_write on core.plugin_activations for all
  using (core.is_admin(tenant_id)) with check (core.is_admin(tenant_id));
create policy plugin_settings_read  on core.plugin_settings for select using (core.is_admin(tenant_id));
create policy plugin_settings_write on core.plugin_settings for all
  using (core.is_admin(tenant_id)) with check (core.is_admin(tenant_id));

-- tenant_domains: admin+ (custom domains are a paid, owner/admin concern).
create policy tenant_domains_rw on core.tenant_domains for all
  using (core.is_admin(tenant_id)) with check (core.is_admin(tenant_id));

-- audit_log / email_events: read-only to admin+; writes happen in-tx via triggers/use-cases or service role.
create policy audit_log_read    on core.audit_log    for select using (core.is_admin(tenant_id));
create policy email_events_read on core.email_events for select using (core.is_admin(tenant_id));

-- outbox: NO ordinary-caller policies — it is written in-tx by use-cases (the caller's own RLS lets the INSERT
-- happen because the use-case runs as the caller) and drained by the dispatcher via the service role. Default
-- deny on select keeps the event stream private. (An explicit insert policy for members of the row's tenant:)
create policy outbox_member_insert on core.outbox for insert with check (tenant_id is null or core.is_member_of(tenant_id));

-- notifications: a user reads/updates only their own.
create policy notifications_self_read   on core.notifications for select using (user_id = core.current_user_id());
create policy notifications_self_update on core.notifications for update using (user_id = core.current_user_id()) with check (user_id = core.current_user_id());

-- platform_admins: visible only to platform operators themselves (doc 04 §6) — never to tenant members.
create policy platform_admins_read on core.platform_admins for select using (core.is_platform_admin('support'));
