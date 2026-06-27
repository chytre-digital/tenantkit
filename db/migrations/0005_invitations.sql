-- ILLUSTRATIVE MOCKUP — the generic "invite a user by email" capability (docs/05-auth.md §2b staff invite,
-- §3 participant linking). Migration 0005: core invitations + the participant-account link they create.
--
-- DELIBERATELY participant-generic — there is NO "guardian" in core. The two things you can invite by email are:
--   • a PARTICIPANT ACCOUNT — a user linked to a participant; base relation 'self' (an adult / own-type
--     participant managing their own enrollment). An app MAY use other relation VALUES (e.g. a kid's account is
--     relation 'guardian') — but that is app vocabulary, not a core concept.
--   • a STAFF membership — a rank-capped core.memberships row.
-- core.participant_accounts + core.can_act_for_participant() SUPERSEDE the legacy guardian-named
-- core.guardianships + core.guardian_can_act() from 0001_core.sql. (Termínář, an early adopter, still ships the
-- guardian names: its core.guardianships ≙ this core.participant_accounts, core.guardian_can_act ≙
-- core.can_act_for_participant, with relation 'guardian' for kids and 'self' for adults. New apps use these.)
--
-- The invitation token is the app-side claim; the identity-provider account + sign-in are the adapter's. So
-- core.accept_invitation takes the actor id AND the actor's VERIFIED email EXPLICITLY (a service-role connection
-- has no JWT to read them from) — vendor-neutral, no auth.users read in core. The adapter resolves "does an
-- account exist for this email?" and the verified email its own way (the Supabase adapter reads auth.users).
--
-- Mirrors the kernel SQL building blocks @deverjak/tenantkit-kernel src/db (PARTICIPANT_ACCOUNTS_SQL,
-- CAN_ACT_FOR_PARTICIPANT_SQL, INVITATIONS_SQL, ACCEPT_INVITATION_SQL, INVITATIONS_ALL_SQL).

-- ── core.participant_accounts — the generic user ↔ participant link (supersedes core.guardianships). ──
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

-- May the caller act for this participant? SECURITY DEFINER (supersedes core.guardian_can_act).
create or replace function core.can_act_for_participant(p_participant uuid)
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from core.participant_accounts pa
    where pa.participant_id = p_participant and pa.user_id = core.current_user_id()
  )
$$;

-- ── core.invitations — kind 'participant' (→ participant_account) | 'staff' (→ rank-capped membership). The
--    PENDING state lives here so participant_accounts / memberships only ever get a row with a real user_id. ──
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

-- ── core.accept_invitation — bind to a VERIFIED user → participant_account or membership. SECURITY DEFINER to
--    break the RLS chicken-and-egg, like core.create_tenant_with_owner. Verified email passed explicitly. ──
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

-- ── RLS (default deny; mirrors the rest of core). Admin+ manage invites + read the links; a user reads their own.
alter table core.participant_accounts enable row level security;
alter table core.invitations          enable row level security;

create policy participant_accounts_self_read  on core.participant_accounts for select using (user_id = core.current_user_id());
create policy participant_accounts_admin_read on core.participant_accounts for select using (core.is_member_of(tenant_id, 'admin'));
create policy invitations_admin_rw on core.invitations for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
