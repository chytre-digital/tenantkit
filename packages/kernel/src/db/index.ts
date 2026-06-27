/**
 * Realizes docs/02-reservation-core.md §14 and docs/03-data-model.md §7 — SQL building blocks
 * (`@reservation-core/db`).
 *
 * The SQL the apps would otherwise copy-paste. Crucially this DRYs the RLS membership check both reference apps
 * inline everywhere — the inline subquery that caused Restaurio's "infinite recursion in policy" incident.
 * `core.is_member_of()` is SECURITY DEFINER so a policy on `memberships` that must read `memberships` does NOT
 * recurse. Exported as SQL text a migration applies (the real package ships .sql files + a migration helper).
 *
 * PORTABILITY (docs/14-portability-and-providers.md): these functions identify the caller via
 * `core.current_user_id()` — NOT Supabase's `auth.uid()` — so the same RLS works on ANY Postgres. The Supabase
 * adapter resolves it from the PostgREST-injected `request.jwt.claims` GUC; a direct-driver adapter resolves it
 * from an `app.user_id` GUC it sets with `SET LOCAL` per request transaction. One indirection, every Postgres.
 */

/**
 * The PORTABILITY seam (doc 14): the caller's id, resolved from EITHER the Supabase/PostgREST JWT-claims GUC
 * OR a plain `app.user_id` GUC a direct-driver adapter sets with `SET LOCAL`. Every RLS predicate below calls
 * THIS, not `auth.uid()` — so the identical policies run on Supabase, Neon, RDS, or a laptop Postgres.
 * On Supabase you may simply `create function core.current_user_id() ... select auth.uid()` instead.
 */
export const CURRENT_USER_ID_SQL = /* sql */ `
create or replace function core.current_user_id()
  returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub',  -- Supabase / PostgREST path
    nullif(current_setting('app.user_id', true), '')                          -- direct-driver path (SET LOCAL)
  )::uuid
$$;
`

/**
 * The ONE membership predicate. SECURITY DEFINER + STABLE to avoid RLS recursion (doc 03 §7).
 * A table's tenant-isolation policy reads `core.is_member_of(tenant_id)` — never an inline subquery.
 */
export const IS_MEMBER_OF_SQL = /* sql */ `
create or replace function core.is_member_of(p_tenant uuid, p_min_role text default 'staff')
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from core.memberships m
    where m.tenant_id = p_tenant
      and m.user_id = core.current_user_id()
      and core.role_rank(m.role) >= core.role_rank(p_min_role)
  )
$$;
`

/** Caller's own role in a tenant — the SECURITY DEFINER companion to is_member_of (doc 04 §5). */
export const MY_ROLE_SQL = /* sql */ `
create or replace function core.my_role(p_tenant uuid)
  returns text language sql security definer stable as $$
  select m.role::text from core.memberships m
  where m.tenant_id = p_tenant and m.user_id = core.current_user_id()
$$;
`

/** Total order on roles (must match rbac/roles.ts `roleRank`, doc 02 §9). */
export const ROLE_RANK_SQL = /* sql */ `
create or replace function core.role_rank(p_role text)
  returns int language sql immutable as $$
  select case p_role
    when 'owner' then 4 when 'admin' then 3 when 'coach' then 2 when 'staff' then 1 else 0 end
$$;
`

/** BEFORE-UPDATE trigger to maintain `updated_at` (doc 03 §1). Attach per table. */
export const SET_UPDATED_AT_SQL = /* sql */ `
create or replace function core.set_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end;
$$;
`

/**
 * GENERIC AUDIT TRAIL (any table) — three SQL building blocks an app applies once, then attaches the
 * trigger per table it wants audited (attendance, enrollments, …). The dispute-resolution use case: a
 * forensic, append-only "who changed what, from what to what, and when" record that survives the
 * last-writer stamp being overwritten.
 *
 * THE load-bearing detail: an app that writes through a service-role connection has NO JWT, so
 * `core.current_user_id()` is NULL inside the trigger — the actor cannot be learned from the request.
 * It is instead PASSED EXPLICITLY by each write function via `core.set_audit_actor()`, which stows it in
 * a transaction-local GUC the AFTER trigger reads. Transaction-local (`set_config(..., true)`) → visible
 * to triggers in the same PostgREST transaction, isolated between concurrent requests.
 */

/** The append-only audit table. `source` distinguishes staff writes from the (future) public family portal. */
export const AUDIT_LOG_SQL = /* sql */ `
create table if not exists core.audit_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references core.tenants(id) on delete cascade,   -- null for cross-tenant ops
  actor_user_id uuid,                                                 -- from app.actor_id GUC; null if not set
  action        text not null,                                        -- INSERT | UPDATE | DELETE
  entity        text,                                                 -- the table name (TG_TABLE_NAME)
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  source        text,                                                 -- 'staff' | 'family-portal' | null
  at            timestamptz not null default now()
);
create index if not exists audit_log_entity_idx on core.audit_log (entity, entity_id, at desc);
create index if not exists audit_log_tenant_idx on core.audit_log (tenant_id, at desc);
`

/** Stash the actor + source for the rest of the transaction so the audit trigger can read them. */
export const SET_AUDIT_ACTOR_SQL = /* sql */ `
create or replace function core.set_audit_actor(p_actor uuid, p_source text default null)
  returns void language sql as $$
  select set_config('app.actor_id', coalesce(p_actor::text, ''), true),
         set_config('app.audit_source', coalesce(p_source, ''), true);
$$;
`

/**
 * The ONE generic row trigger. Reads the actor/source GUCs, derives tenant_id/entity_id from the row's
 * conventional `tenant_id`/`id` columns, and appends one audit_log row with before/after snapshots.
 * SECURITY DEFINER so it can insert into core.audit_log regardless of the caller's role.
 */
export const AUDIT_ROW_TRIGGER_FN_SQL = /* sql */ `
create or replace function core.audit_row()
  returns trigger language plpgsql security definer set search_path = core as $$
declare
  v_actor  uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_source text := nullif(current_setting('app.audit_source', true), '');
begin
  if (tg_op = 'DELETE') then
    insert into core.audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after, source)
    values (old.tenant_id, v_actor, tg_op, tg_table_name, old.id, to_jsonb(old), null, v_source);
    return old;
  elsif (tg_op = 'UPDATE') then
    if old is not distinct from new then return new; end if;   -- skip no-op updates
    insert into core.audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after, source)
    values (new.tenant_id, v_actor, tg_op, tg_table_name, new.id, to_jsonb(old), to_jsonb(new), v_source);
    return new;
  else  -- INSERT
    insert into core.audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after, source)
    values (new.tenant_id, v_actor, tg_op, tg_table_name, new.id, null, to_jsonb(new), v_source);
    return new;
  end if;
end $$;
`

/** Attach the generic trigger to one table — `audit_<table>` fires on every insert/update/delete. */
export function attachAuditTriggerSql(table: string): string {
  return /* sql */ `
drop trigger if exists audit_${table} on core.${table};
create trigger audit_${table} after insert or update or delete on core.${table}
  for each row execute function core.audit_row();
`
}

/** Everything the generic audit trail needs, in dependency order (table → setter → trigger fn). */
export const AUDIT_SQL = [AUDIT_LOG_SQL, SET_AUDIT_ACTOR_SQL, AUDIT_ROW_TRIGGER_FN_SQL].join('\n')

/** The atomic provisioning RPC behind `provisionTenant` (doc 02 §8). */
export const CREATE_TENANT_WITH_OWNER_SQL = /* sql */ `
create or replace function core.create_tenant_with_owner(p_name text, p_slug text, p_owner uuid)
  returns uuid language plpgsql security definer as $$
  declare v_id uuid;
  begin
    insert into core.tenants (name, slug) values (p_name, p_slug) returning id into v_id;
    insert into core.memberships (user_id, tenant_id, role) values (p_owner, v_id, 'owner');
    return v_id;
  end;
$$;
`

/** Everything a fresh schema needs, in dependency order — applied by the migration helper. */
export const CORE_FUNCTIONS_SQL = [
  CURRENT_USER_ID_SQL, // must exist before the predicates that call it
  ROLE_RANK_SQL,
  IS_MEMBER_OF_SQL,
  MY_ROLE_SQL,
  SET_UPDATED_AT_SQL,
  CREATE_TENANT_WITH_OWNER_SQL,
].join('\n')

/**
 * PARTICIPANT ACCOUNTS + INVITATIONS — the generic, vendor-neutral building blocks for "invite a user by email".
 *
 * Two concepts, both "invited by email": a PARTICIPANT ACCOUNT (a user linked to a participant; base relation
 * 'self' — an adult/own participant managing their own enrollment) and a STAFF membership. There is deliberately
 * NO "guardian" here: "guardian" is only ever an APP-LEVEL relation VALUE (e.g. a kid's account) — core stays
 * participant-generic. `core.participant_accounts` + `core.can_act_for_participant()` are the participant ↔ user
 * link and its SECURITY DEFINER RLS predicate.
 *
 * The invitation token is the app-side claim; the identity-provider account + sign-in are the adapter's. So
 * `accept_invitation` takes the actor id AND the actor's VERIFIED email EXPLICITLY (a service-role connection
 * has no JWT to read them from) — keeping it vendor-neutral (no `auth.users` read in core). The Supabase adapter
 * resolves the user-by-email and the verified email from `auth.users`; a different adapter resolves them its way.
 */

/** Generic participant-account link — a user who may act for a participant. `relation` defaults to 'self'. */
export const PARTICIPANT_ACCOUNTS_SQL = /* sql */ `
create table if not exists core.participant_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  participant_id uuid not null,                                  -- → the app's participants table (FK added by the app)
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  relation       text not null default 'self',                  -- 'self' (adult/own) | app values e.g. 'guardian','parent'
  is_primary     boolean not null default true,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (user_id, participant_id)
);
create index if not exists participant_accounts_user_idx        on core.participant_accounts(user_id);
create index if not exists participant_accounts_participant_idx on core.participant_accounts(participant_id);
alter table core.participant_accounts enable row level security;
create policy participant_accounts_self_read  on core.participant_accounts for select using (user_id = core.current_user_id());
create policy participant_accounts_admin_read on core.participant_accounts for select using (core.is_member_of(tenant_id, 'admin'));
`

/** May the caller act for this participant? SECURITY DEFINER RLS predicate (the participant-account gate). */
export const CAN_ACT_FOR_PARTICIPANT_SQL = /* sql */ `
create or replace function core.can_act_for_participant(p_participant uuid)
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from core.participant_accounts pa
    where pa.participant_id = p_participant and pa.user_id = core.current_user_id()
  )
$$;
`

/** Generic invitations — kind 'participant' (→ participant_account) | 'staff' (→ rank-capped membership). */
export const INVITATIONS_SQL = /* sql */ `
create table if not exists core.invitations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  email            text not null,
  kind             text not null check (kind in ('participant', 'staff')),
  role             core.app_role,                                              -- staff invites only
  participant_id   uuid,                                                       -- participant invites only
  relation         text,                                                       -- 'self' | app values
  token            uuid not null unique default gen_random_uuid(),
  status           text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by       uuid,
  invited_by_role  core.app_role,                                              -- snapshot for the staff rank-cap at accept
  expires_at       timestamptz not null default (now() + interval '14 days'),
  accepted_at      timestamptz,
  accepted_user_id uuid,
  created_at       timestamptz not null default now()
);
create unique index if not exists invitations_pending_participant_uniq
  on core.invitations (tenant_id, lower(email), participant_id) where status = 'pending' and kind = 'participant';
create unique index if not exists invitations_pending_staff_uniq
  on core.invitations (tenant_id, lower(email)) where status = 'pending' and kind = 'staff';
alter table core.invitations enable row level security;
create policy invitations_admin_rw on core.invitations for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
`

/**
 * Bind an invitation to a VERIFIED user → participant_account or rank-capped membership. SECURITY DEFINER to
 * break the RLS chicken-and-egg (insert into a tenant the user isn't in yet), like create_tenant_with_owner.
 * Vendor-neutral: the adapter passes the authenticated user's id AND verified email (no auth.users read here).
 */
export const ACCEPT_INVITATION_SQL = /* sql */ `
create or replace function core.accept_invitation(p_token uuid, p_user uuid, p_user_email text)
  returns table (tenant_id uuid, kind text)
  language plpgsql security definer as $$
declare v_inv core.invitations%rowtype;
begin
  select * into v_inv from core.invitations where token = p_token for update;
  if not found                 then raise exception 'invite_not_found'  using errcode = 'P0001'; end if;
  if v_inv.status <> 'pending' then raise exception 'invite_not_pending' using errcode = 'P0001'; end if;
  if v_inv.expires_at <= now() then
    update core.invitations set status = 'expired' where id = v_inv.id;
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;
  if p_user_email is null or lower(p_user_email) is distinct from lower(v_inv.email) then
    raise exception 'invite_email_mismatch' using errcode = 'P0001';
  end if;

  if v_inv.kind = 'participant' then
    insert into core.participant_accounts (user_id, participant_id, tenant_id, relation, is_primary, created_by)
    values (p_user, v_inv.participant_id, v_inv.tenant_id, coalesce(v_inv.relation, 'self'), true, v_inv.invited_by)
    on conflict (user_id, participant_id) do nothing;
  else
    if v_inv.role is null or v_inv.role = 'owner'
       or core.role_rank(v_inv.role::text) >= core.role_rank(coalesce(v_inv.invited_by_role::text, 'owner')) then
      raise exception 'invite_role_invalid' using errcode = 'P0001';
    end if;
    insert into core.memberships (user_id, tenant_id, role)
    values (p_user, v_inv.tenant_id, v_inv.role)
    on conflict (user_id, tenant_id) do nothing;
  end if;

  update core.invitations set status = 'accepted', accepted_user_id = p_user, accepted_at = now() where id = v_inv.id;
  return query select v_inv.tenant_id, v_inv.kind;
end $$;
`

/** The whole invitation system, in dependency order — applied by the migration helper. */
export const INVITATIONS_ALL_SQL = [
  PARTICIPANT_ACCOUNTS_SQL,
  CAN_ACT_FOR_PARTICIPANT_SQL,
  INVITATIONS_SQL,
  ACCEPT_INVITATION_SQL,
].join('\n')
