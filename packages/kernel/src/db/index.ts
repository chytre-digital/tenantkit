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

/** Family predicate: may this guardian act for the participant? SECURITY DEFINER (doc 04 §7). */
export const GUARDIAN_CAN_ACT_SQL = /* sql */ `
create or replace function core.guardian_can_act(p_participant uuid)
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from core.guardianships g
    where g.participant_id = p_participant and g.user_id = core.current_user_id()
  )
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
  GUARDIAN_CAN_ACT_SQL,
  SET_UPDATED_AT_SQL,
  CREATE_TENANT_WITH_OWNER_SQL,
].join('\n')
