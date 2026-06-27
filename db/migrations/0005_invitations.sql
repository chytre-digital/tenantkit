-- ILLUSTRATIVE MOCKUP — the generic "invite a user by email" capability (docs/05-auth.md §2b staff invite,
-- §3 participant linking). Migration 0005: core.invitations + the accept RPC that turns an invite into a
-- participant-account link (or a staff membership).
--
-- DELIBERATELY participant-generic — there is NO "guardian" in core. The two things you can invite by email are:
--   • a PARTICIPANT ACCOUNT — a user linked to a participant; base relation 'self' (an adult / own-type
--     participant managing their own enrollment). An app MAY use other relation VALUES (e.g. a kid's account is
--     relation 'guardian') — but that is app vocabulary, not a core concept.
--   • a STAFF membership — a rank-capped core.memberships row.
-- The link table core.participant_accounts and its RLS predicate core.can_act_for_participant() are defined in
-- 0001_core.sql; this migration only adds the invitations that CREATE participant_account / membership rows.
--
-- The invitation token is the app-side claim; the identity-provider account + sign-in are the adapter's. So
-- core.accept_invitation takes the actor id AND the actor's VERIFIED email EXPLICITLY (a service-role connection
-- has no JWT to read them from) — vendor-neutral, no auth.users read in core. The adapter resolves "does an
-- account exist for this email?" and the verified email its own way (the Supabase adapter reads auth.users).
--
-- Mirrors the kernel SQL building blocks @deverjak/tenantkit-kernel src/db (INVITATIONS_SQL, ACCEPT_INVITATION_SQL;
-- the link table + predicate are PARTICIPANT_ACCOUNTS_SQL / CAN_ACT_FOR_PARTICIPANT_SQL, applied via 0001).

-- ── core.invitations — kind 'participant' (→ participant_account) | 'staff' (→ rank-capped membership). The
--    PENDING state lives here so core.participant_accounts / core.memberships only ever get a row with a real
--    user_id (at accept time). ──
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
-- at most one PENDING invite per (tenant,email,participant) for participant; per (tenant,email) for staff.
create unique index if not exists invitations_pending_participant_uniq
  on core.invitations (tenant_id, lower(email), participant_id) where status = 'pending' and kind = 'participant';
create unique index if not exists invitations_pending_staff_uniq
  on core.invitations (tenant_id, lower(email)) where status = 'pending' and kind = 'staff';

-- ── core.accept_invitation — bind an invite to a VERIFIED user → participant_account or rank-capped membership.
--    SECURITY DEFINER to break the RLS chicken-and-egg (insert into a tenant the user isn't in yet), like
--    create_tenant_with_owner. Vendor-neutral: the adapter passes the user's id AND verified email (no auth.users
--    read in core). ──
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
    raise exception 'invite_email_mismatch' using errcode = 'P0001';                    -- bind only on a verified email
  end if;

  if v_inv.kind = 'participant' then
    insert into core.participant_accounts (user_id, participant_id, tenant_id, relation, is_primary, created_by)
    values (p_user, v_inv.participant_id, v_inv.tenant_id, coalesce(v_inv.relation, 'self'), true, v_inv.invited_by)
    on conflict (user_id, participant_id) do nothing;
  else  -- staff: rank-cap — never 'owner', never a role >= the inviter's snapshotted role.
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

-- ── RLS (default deny; mirrors the rest of core). Admin+ manage their tenant's invites. The link table's own RLS
--    (participant_accounts_self_read / _admin_read) is set in 0001_core.sql. ──
alter table core.invitations enable row level security;
create policy invitations_admin_rw on core.invitations for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
