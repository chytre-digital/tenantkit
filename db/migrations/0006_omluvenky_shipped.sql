-- SHIPPED REFERENCE — the omluvenky design as first shipped in terminar (2026-07). SUPERSEDES the illustrative
-- 0003_omluvenky.sql for the shipped subset (see docs/08 "As shipped" addendum). Differences from 0003 that a
-- consumer app should copy from HERE, not from 0003:
--   • schema `core.*` with text+CHECK statuses (no public.* enums), single `excusal_credits` table — the
--     attendance row IS the excuse (no separate `excuses` table),
--   • explicit-actor SECURITY DEFINER RPCs (`p_actor` argument): the app's data client is the JWT-less
--     service role, so `auth.uid()`/`core.current_user_id()` are NULL and 0003's RLS-user idiom cannot work,
--   • no `windows` expiry mode, no redeemMatch enforcement yet (tags ARE snapshotted for later),
--   • capacity is COURSE-level with the excused-frees-seat rule (below); no per-session capacity_override,
--   • `save_course_with_sessions` preserve-by-id semantics so attendance/credits/makeups survive course edits.
-- The backfill block (§5) and the two pre-existing RPC redefinitions (§6/§7) are consumer-specific: adapt the
-- bodies to YOUR app's excusal/attendance functions. Verbatim source of this file:
-- terminar/supabase/migrations/20260706130000_core_excusal_credits_makeups.sql.
--
-- Omluvenkové tokeny + náhrady (excusal credits + make-up bookings), docs/08-attendance-and-omluvenky.md
-- shipped subset. An excusal (portal self-excuse OR staff mark) MINTS a credit with a FIXED expires_at
-- computed at issue time from the source course's excuse_policy.expiry, falling back to the tenant default in
-- core.tenants.settings.excusalCredits. A valid credit books a make-up seat on ANOTHER course's future session
-- when a spot is free: free = capacity − activeEnrollments + excusedForSession − bookedMakeups (an enrollee who
-- excused themselves frees their seat for that one session).
--
-- Same explicit-actor SECURITY DEFINER idiom as record_attendance / set_participant_excusal (the app's data
-- client is the JWT-less service role, so auth.uid() is NULL inside these functions — authorization keys on the
-- passed p_actor). TS mirror of the pure rules: @deverjak/tenantkit-reservation-core/credits (computeExpiry /
-- isRedeemableNow / freeMakeupCapacity / summarizeCredits); SQL re-enforces them atomically — dual enforcement
-- by design (docs/08 §13). Expiry is evaluated LIVE everywhere (expires_at >= now(), inclusive, matching the
-- engine); status 'expired' is reserved for a future display sweeper and is never load-bearing.

-- ── 1. per-course expiry override ─────────────────────────────────────────────────────────────────────────
-- '{}' = inherit the tenant default; '{"expiry":{"mode":"none"|"ttl"|"course_end","ttlDays":N}}' = override.
alter table core.courses
  add column if not exists excuse_policy jsonb not null default '{}'::jsonb;

-- ── 2. core.excusal_credits — THE TOKEN ───────────────────────────────────────────────────────────────────
create table if not exists core.excusal_credits (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  participant_id    uuid not null references core.participants(id) on delete cascade,
  source_course_id  uuid references core.courses(id)  on delete set null,   -- where the excusal happened
  source_session_id uuid references core.sessions(id) on delete set null,   -- the excused lesson
  source            text not null default 'excusal' check (source in ('excusal', 'backfill', 'staff_grant')),
  tags              text[] not null default '{}',       -- snapshot of the source course's tags at issue time
  status            text not null default 'active' check (status in ('active', 'redeemed', 'expired', 'cancelled')),
  issued_at         timestamptz not null default now(),
  expires_at        timestamptz,                        -- null = never expires; FIXED at issue, never recomputed
  redeemed_at       timestamptz,
  note              text,                               -- staff note (future grants/extends)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One live (non-cancelled) credit per excused lesson. Un-excusing/correcting cancels the credit, so a genuine
-- re-excuse mints anew; a REDEEMED credit blocks re-mint on purpose (that omluvenka was already spent).
create unique index if not exists excusal_credits_one_per_session
  on core.excusal_credits (source_session_id, participant_id)
  where source_session_id is not null and status <> 'cancelled';
create index if not exists excusal_credits_participant_idx
  on core.excusal_credits (tenant_id, participant_id, status);

drop trigger if exists set_updated_at on core.excusal_credits;
create trigger set_updated_at before update on core.excusal_credits
  for each row execute function core.set_updated_at();

alter table core.excusal_credits enable row level security;
drop policy if exists excusal_credits_member_read on core.excusal_credits;
create policy excusal_credits_member_read on core.excusal_credits
  for select using (core.is_member_of(tenant_id));
drop policy if exists excusal_credits_family_read on core.excusal_credits;
create policy excusal_credits_family_read on core.excusal_credits
  for select using (core.can_act_for_participant(participant_id));
-- writes go exclusively through the SECURITY DEFINER RPCs below (service-role bypasses RLS; no write policies).
grant select, insert, update, delete on core.excusal_credits to service_role;
grant select on core.excusal_credits to authenticated;

drop trigger if exists audit_excusal_credits on core.excusal_credits;
create trigger audit_excusal_credits after insert or update or delete on core.excusal_credits
  for each row execute function core.audit_row();

-- ── 3. core.makeups — a seat booked with a credit ("náhrada") ─────────────────────────────────────────────
-- A make-up is a SESSION booking, not a course enrollment (enrollments.source='makeup' stays unused).
create table if not exists core.makeups (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  credit_id      uuid not null references core.excusal_credits(id) on delete restrict,
  participant_id uuid not null references core.participants(id) on delete cascade,
  session_id     uuid references core.sessions(id) on delete set null,  -- survives session deletion: save_course
                                                                        -- v2 cancels + restores the credit first,
                                                                        -- the row stays for history (null = removed)
  course_id      uuid not null references core.courses(id) on delete cascade,   -- denormalized from the session
  status         text not null default 'booked' check (status in ('booked', 'cancelled', 'attended')),
  booked_by      uuid,                                   -- the acting auth user (parent or coach)
  booked_at      timestamptz not null default now(),
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists makeups_one_booked_per_session
  on core.makeups (session_id, participant_id) where status = 'booked';
create index if not exists makeups_session_idx     on core.makeups (session_id, status);
create index if not exists makeups_participant_idx on core.makeups (tenant_id, participant_id);
create index if not exists makeups_credit_idx      on core.makeups (credit_id);

drop trigger if exists set_updated_at on core.makeups;
create trigger set_updated_at before update on core.makeups
  for each row execute function core.set_updated_at();

alter table core.makeups enable row level security;
drop policy if exists makeups_member_read on core.makeups;
create policy makeups_member_read on core.makeups
  for select using (core.is_member_of(tenant_id));
drop policy if exists makeups_family_read on core.makeups;
create policy makeups_family_read on core.makeups
  for select using (core.can_act_for_participant(participant_id));
grant select, insert, update, delete on core.makeups to service_role;
grant select on core.makeups to authenticated;

drop trigger if exists audit_makeups on core.makeups;
create trigger audit_makeups after insert or update or delete on core.makeups
  for each row execute function core.audit_row();

-- ── 4. policy helpers — SQL mirror of the engine's computeExpiry + the module toggle ──────────────────────
-- Module toggle: settings.excusalCredits.enabled, DEFAULT ENABLED when unset.
create or replace function core.excusal_credits_enabled(p_tenant uuid)
  returns boolean language sql stable security definer set search_path = core as $$
  select coalesce((settings #>> '{excusalCredits,enabled}')::boolean, true)
  from core.tenants where id = p_tenant
$$;
revoke execute on function core.excusal_credits_enabled(uuid) from public;
grant  execute on function core.excusal_credits_enabled(uuid) to service_role;

-- Expiry: course excuse_policy.expiry override → tenant settings.excusalCredits.defaultExpiry → ttl 30 dní.
-- Mirrors @deverjak/tenantkit-reservation-core/credits computeExpiry (none → null; course_end → the source
-- course's LAST session, null when it has none; ttl → issued_at + ttlDays).
create or replace function core.compute_credit_expiry(p_tenant uuid, p_course uuid, p_issued_at timestamptz)
  returns timestamptz language plpgsql stable security definer set search_path = core as $$
declare
  v_policy jsonb;
  v_mode   text;
begin
  select excuse_policy -> 'expiry' into v_policy from core.courses where id = p_course;
  if v_policy is null or jsonb_typeof(v_policy) is distinct from 'object' then
    select settings #> '{excusalCredits,defaultExpiry}' into v_policy from core.tenants where id = p_tenant;
  end if;

  v_mode := coalesce(v_policy ->> 'mode', 'ttl');
  if v_mode = 'none' then
    return null;
  elsif v_mode = 'course_end' then
    return (select max(starts_at) from core.sessions where course_id = p_course);
  else  -- 'ttl' (and any unknown mode degrades to the safe default)
    return p_issued_at + make_interval(days => coalesce((v_policy ->> 'ttlDays')::int, 30));
  end if;
end $$;
revoke execute on function core.compute_credit_expiry(uuid, uuid, timestamptz) from public;
grant  execute on function core.compute_credit_expiry(uuid, uuid, timestamptz) to service_role;

-- ── 5. BACKFILL — mint from existing excused marks so history ("získáno/využito") is honest ───────────────
-- issued_at = the original marked_at; expiry computed with TODAY's policy (older ones will already be past).
-- Only enrolled excusees earn a token (a guest's excused mark frees nothing and mints nothing).
insert into core.excusal_credits
  (tenant_id, participant_id, source_course_id, source_session_id, source, tags, status, issued_at, expires_at)
select a.tenant_id, a.participant_id, s.course_id, a.session_id, 'backfill',
       coalesce(c.tags, '{}'), 'active', a.marked_at,
       core.compute_credit_expiry(a.tenant_id, s.course_id, a.marked_at)
from core.attendance a
join core.sessions s on s.id = a.session_id
join core.courses  c on c.id = s.course_id
where a.state = 'excused' and a.enrollment_id is not null
on conflict (source_session_id, participant_id)
  where source_session_id is not null and status <> 'cancelled'
  do nothing;

-- ── 6. core.set_participant_excusal v3 — mint on excuse, cancel on un-excuse ──────────────────────────────
-- Body copied from 20260627190000 (authorization on the PASSED actor; family deadline window) + the credit
-- hooks. Mint only on a real transition INTO 'excused' for an enrolled participant while the module is on;
-- un-excusing cancels the still-active credit and NEVER touches a redeemed one (spent is spent).
create or replace function core.set_participant_excusal(
  p_tenant uuid, p_actor uuid, p_session uuid, p_participant uuid, p_excused boolean, p_reason text
) returns text language plpgsql security definer set search_path = core as $$
declare
  v_course     uuid;
  v_enrollment uuid;
  v_starts     timestamptz;
  v_deadline_h int;
  v_is_linked  boolean;   -- the actor holds a participant-account link for p_participant
  v_is_coach   boolean;
  v_prev       text;      -- attendance state BEFORE this write (null = no row)
begin
  -- authorize against the PASSED actor (works under the JWT-less service-role connection).
  v_is_linked := exists (select 1 from core.participant_accounts pa
                         where pa.participant_id = p_participant and pa.user_id = p_actor);
  v_is_coach  := exists (select 1 from core.memberships m
                         where m.tenant_id = p_tenant and m.user_id = p_actor
                           and core.role_rank(m.role::text) >= core.role_rank('coach'));
  if not (v_is_linked or v_is_coach) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  -- the session must belong to this tenant; resolve its course (for enrollment linkage) + start time.
  select course_id, starts_at into v_course, v_starts
    from core.sessions where id = p_session and tenant_id = p_tenant;
  if v_course is null then raise exception 'session_not_found' using errcode = 'P0001'; end if;

  select id into v_enrollment from core.enrollments
    where course_id = v_course and participant_id = p_participant and status = 'active' limit 1;

  -- a participant-linked account (not also a coach) may only excuse an actively-enrolled participant, only for a
  -- session that has not yet started, and only before the per-tenant deadline window. Coaches bypass all three.
  if v_is_linked and not v_is_coach then
    if v_enrollment is null then raise exception 'not_enrolled' using errcode = 'P0001'; end if;
    if p_excused then
      select coalesce((settings->>'excuseDeadlineHours')::int, 24) into v_deadline_h
        from core.tenants where id = p_tenant;
      if now() > v_starts - make_interval(hours => v_deadline_h) then
        raise exception 'excuse_window_closed' using errcode = 'P0001';
      end if;
    end if;
  end if;

  perform core.set_audit_actor(p_actor, case when v_is_coach then 'staff' else 'family-portal' end);

  select state into v_prev from core.attendance
    where session_id = p_session and participant_id = p_participant;

  if p_excused then
    insert into core.attendance (tenant_id, session_id, participant_id, enrollment_id, state,
                                 marked_by, marked_at, excuse_reason, excused_via)
    values (p_tenant, p_session, p_participant, v_enrollment, 'excused',
            p_actor, now(), nullif(p_reason, ''), case when v_is_coach then 'staff' else 'portal' end)
    on conflict (session_id, participant_id) do update
      set state = 'excused', enrollment_id = excluded.enrollment_id,
          marked_by = excluded.marked_by, marked_at = now(),
          excuse_reason = excluded.excuse_reason, excused_via = excluded.excused_via
      where core.attendance.state is distinct from 'excused';   -- no churn/audit if already excused

    -- MINT: a real transition into 'excused' by an enrolled participant earns a credit (module on).
    -- ON CONFLICT (the partial-unique) makes concurrent double-excusals a clean no-op.
    if v_prev is distinct from 'excused' and v_enrollment is not null
       and core.excusal_credits_enabled(p_tenant) then
      insert into core.excusal_credits
        (tenant_id, participant_id, source_course_id, source_session_id, source, tags, expires_at)
      select p_tenant, p_participant, v_course, p_session, 'excusal',
             coalesce(c.tags, '{}'), core.compute_credit_expiry(p_tenant, v_course, now())
      from core.courses c where c.id = v_course
      on conflict (source_session_id, participant_id)
        where source_session_id is not null and status <> 'cancelled'
        do nothing;
    end if;
    return 'excused';
  else
    -- un-excuse: only clear a row that is currently 'excused' (never clobber a coach's present/absent mark).
    update core.attendance
       set state = 'unmarked', marked_by = p_actor, marked_at = now(),
           excuse_reason = null, excused_via = case when v_is_coach then 'staff' else 'portal' end
     where session_id = p_session and participant_id = p_participant and state = 'excused';

    -- CANCEL the unspent credit minted from this lesson (a redeemed credit is untouched — spent is spent).
    if v_prev = 'excused' then
      update core.excusal_credits set status = 'cancelled'
       where source_session_id = p_session and participant_id = p_participant and status = 'active';
    end if;
    return 'unmarked';
  end if;
end $$;
revoke execute on function core.set_participant_excusal(uuid, uuid, uuid, uuid, boolean, text) from public;
grant  execute on function core.set_participant_excusal(uuid, uuid, uuid, uuid, boolean, text) to service_role;

-- ── 7. core.record_attendance v3 — same mint/cancel hooks + the make-up attended flip ─────────────────────
-- Body copied from 20260627090000. Per mark: capture the prior state, write, then
--   • 'present' flips a booked make-up for (session, participant) to 'attended'; any other state reverts it,
--   • a transition INTO 'excused' (enrolled, module on) mints a credit,
--   • a transition OUT OF 'excused' cancels the still-active credit (never a redeemed one).
create or replace function core.record_attendance(
  p_tenant uuid, p_actor uuid, p_session uuid, p_marks jsonb
) returns int language plpgsql security definer set search_path = core as $$
declare
  v_course     uuid;
  v_count      int := 0;
  m            jsonb;
  v_pid        uuid;
  v_state      text;
  v_enrollment uuid;
  v_prev       text;
begin
  perform core.set_audit_actor(p_actor, 'staff');

  -- the session must belong to this tenant; resolve its course for enrollment linkage
  select course_id into v_course from core.sessions where id = p_session and tenant_id = p_tenant;
  if v_course is null then
    raise exception 'session_not_found' using errcode = 'P0001';   -- → 422 via jsonError
  end if;

  for m in select value from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb))
  loop
    v_pid   := (m->>'participantId')::uuid;
    v_state := m->>'state';

    -- link to the active enrollment if there is one (nullable — staff may mark a guest)
    select id into v_enrollment from core.enrollments
      where course_id = v_course and participant_id = v_pid and status = 'active'
      limit 1;

    select state into v_prev from core.attendance
      where session_id = p_session and participant_id = v_pid;

    if v_state = 'unmarked' then
      delete from core.attendance where session_id = p_session and participant_id = v_pid;
    else
      insert into core.attendance (tenant_id, session_id, participant_id, enrollment_id, state, marked_by, marked_at)
      values (p_tenant, p_session, v_pid, v_enrollment, v_state, p_actor, now())
      on conflict (session_id, participant_id) do update
        set state = excluded.state, enrollment_id = excluded.enrollment_id,
            marked_by = excluded.marked_by, marked_at = excluded.marked_at
        where core.attendance.state is distinct from excluded.state;
    end if;

    -- make-up flip: showing up spends the booking; correcting away from 'present' un-spends it.
    if v_state = 'present' then
      update core.makeups set status = 'attended'
       where session_id = p_session and participant_id = v_pid and status = 'booked';
    else
      update core.makeups set status = 'booked'
       where session_id = p_session and participant_id = v_pid and status = 'attended';
    end if;

    -- MINT on a real transition into 'excused' (enrolled participants only — guests earn nothing).
    if v_state = 'excused' and v_prev is distinct from 'excused' and v_enrollment is not null
       and core.excusal_credits_enabled(p_tenant) then
      insert into core.excusal_credits
        (tenant_id, participant_id, source_course_id, source_session_id, source, tags, expires_at)
      select p_tenant, v_pid, v_course, p_session, 'excusal',
             coalesce(c.tags, '{}'), core.compute_credit_expiry(p_tenant, v_course, now())
      from core.courses c where c.id = v_course
      on conflict (source_session_id, participant_id)
        where source_session_id is not null and status <> 'cancelled'
        do nothing;
    end if;

    -- CANCEL on a transition out of 'excused' (only an unspent credit; redeemed stays redeemed).
    if v_prev = 'excused' and v_state is distinct from 'excused' then
      update core.excusal_credits set status = 'cancelled'
       where source_session_id = p_session and participant_id = v_pid and status = 'active';
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;
revoke execute on function core.record_attendance(uuid, uuid, uuid, jsonb) from public;
grant  execute on function core.record_attendance(uuid, uuid, uuid, jsonb) to service_role;

-- ── 8. core.book_makeup — spend a credit on a free seat, atomically ───────────────────────────────────────
-- FIFO: the soonest-expiring redeemable credit is spent first (never-expiring last; engine selectCreditFIFO
-- parity). Capacity gate = the submit_application idiom: SELECT … FOR UPDATE on the COURSE row makes the
-- count + insert atomic against concurrent bookings/enrollments/approvals, which lock the same row.
-- Note: the FOR UPDATE … LIMIT 1 credit pick can, under a same-participant concurrent booking, re-evaluate to
-- no row and raise no_credit spuriously — rare and harmless (the client retries).
create or replace function core.book_makeup(
  p_tenant uuid, p_actor uuid, p_participant uuid, p_session uuid
) returns uuid language plpgsql security definer set search_path = core as $$
declare
  v_is_linked boolean;
  v_is_coach  boolean;
  v_course    uuid;
  v_starts    timestamptz;
  v_capacity  int;
  v_enrolled  int;
  v_excused   int;
  v_booked    int;
  v_credit    uuid;
  v_makeup    uuid;
begin
  v_is_linked := exists (select 1 from core.participant_accounts pa
                         where pa.participant_id = p_participant and pa.user_id = p_actor);
  v_is_coach  := exists (select 1 from core.memberships m
                         where m.tenant_id = p_tenant and m.user_id = p_actor
                           and core.role_rank(m.role::text) >= core.role_rank('coach'));
  if not (v_is_linked or v_is_coach) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform core.set_audit_actor(p_actor, case when v_is_coach then 'staff' else 'family-portal' end);

  if not core.excusal_credits_enabled(p_tenant) then
    raise exception 'makeups_disabled' using errcode = 'P0001';
  end if;

  select course_id, starts_at into v_course, v_starts
    from core.sessions where id = p_session and tenant_id = p_tenant;
  if v_course is null then raise exception 'session_not_found' using errcode = 'P0001'; end if;
  if v_starts <= now() then raise exception 'session_in_past' using errcode = 'P0001'; end if;

  -- FIFO credit pick, locked against double-spend (expiry live + inclusive: expires_at >= now()).
  select id into v_credit from core.excusal_credits
   where tenant_id = p_tenant and participant_id = p_participant and status = 'active'
     and (expires_at is null or expires_at >= now())
   order by expires_at asc nulls last, issued_at asc
   limit 1
   for update;
  if v_credit is null then raise exception 'no_credit' using errcode = 'P0001'; end if;

  -- lock the TARGET course row → the occupancy count + insert below are atomic (submit_application idiom).
  select capacity into v_capacity from core.courses
   where id = v_course and tenant_id = p_tenant and status = 'active'
   for update;
  if not found then raise exception 'course_not_active' using errcode = 'P0001'; end if;

  -- an enrollee already owns a seat in every session of their course — náhrada is for OTHER courses.
  if exists (select 1 from core.enrollments e
             where e.course_id = v_course and e.participant_id = p_participant and e.status = 'active') then
    raise exception 'already_enrolled' using errcode = 'P0001';
  end if;
  if exists (select 1 from core.makeups mk
             where mk.session_id = p_session and mk.participant_id = p_participant and mk.status = 'booked') then
    raise exception 'already_booked' using errcode = 'P0001';
  end if;

  -- free = capacity − activeEnrollments + excusedForSession − bookedMakeups (engine freeMakeupCapacity).
  -- Excused seats count only for participants who actually hold an active enrollment in the course.
  select count(*) into v_enrolled from core.enrollments e
   where e.course_id = v_course and e.status = 'active';
  select count(*) into v_excused from core.attendance a
   where a.session_id = p_session and a.state = 'excused'
     and exists (select 1 from core.enrollments e2
                 where e2.course_id = v_course and e2.participant_id = a.participant_id and e2.status = 'active');
  select count(*) into v_booked from core.makeups mk
   where mk.session_id = p_session and mk.status = 'booked';
  if v_capacity - v_enrolled + v_excused - v_booked <= 0 then
    raise exception 'session_full' using errcode = 'P0001';
  end if;

  insert into core.makeups (tenant_id, credit_id, participant_id, session_id, course_id, status, booked_by)
  values (p_tenant, v_credit, p_participant, p_session, v_course, 'booked', p_actor)
  returning id into v_makeup;

  update core.excusal_credits set status = 'redeemed', redeemed_at = now() where id = v_credit;
  return v_makeup;
end $$;
revoke execute on function core.book_makeup(uuid, uuid, uuid, uuid) from public;
grant  execute on function core.book_makeup(uuid, uuid, uuid, uuid) to service_role;

-- ── 9. core.cancel_makeup — release the seat, restore the credit ──────────────────────────────────────────
-- Family actors may cancel only until the excuse window closes (same excuseDeadlineHours as excusals — no new
-- setting); coaches bypass. The credit returns to 'active' with its ORIGINAL expires_at (validity unchanged —
-- if it lapsed meanwhile, live evaluation makes it unusable anyway).
create or replace function core.cancel_makeup(
  p_tenant uuid, p_actor uuid, p_makeup uuid
) returns text language plpgsql security definer set search_path = core as $$
declare
  v_mk         core.makeups%rowtype;
  v_starts     timestamptz;
  v_deadline_h int;
  v_is_linked  boolean;
  v_is_coach   boolean;
begin
  select * into v_mk from core.makeups
   where id = p_makeup and tenant_id = p_tenant
   for update;
  if not found then raise exception 'makeup_not_found' using errcode = 'P0001'; end if;

  v_is_linked := exists (select 1 from core.participant_accounts pa
                         where pa.participant_id = v_mk.participant_id and pa.user_id = p_actor);
  v_is_coach  := exists (select 1 from core.memberships m
                         where m.tenant_id = p_tenant and m.user_id = p_actor
                           and core.role_rank(m.role::text) >= core.role_rank('coach'));
  if not (v_is_linked or v_is_coach) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if v_mk.status <> 'booked' then raise exception 'makeup_not_booked' using errcode = 'P0001'; end if;

  if v_is_linked and not v_is_coach then
    select starts_at into v_starts from core.sessions where id = v_mk.session_id;
    select coalesce((settings->>'excuseDeadlineHours')::int, 24) into v_deadline_h
      from core.tenants where id = p_tenant;
    if v_starts is null or now() > v_starts - make_interval(hours => v_deadline_h) then
      raise exception 'cancel_window_closed' using errcode = 'P0001';
    end if;
  end if;

  perform core.set_audit_actor(p_actor, case when v_is_coach then 'staff' else 'family-portal' end);

  update core.makeups set status = 'cancelled', cancelled_at = now() where id = p_makeup;
  update core.excusal_credits set status = 'active', redeemed_at = null
   where id = v_mk.credit_id and status = 'redeemed';
  return 'cancelled';
end $$;
revoke execute on function core.cancel_makeup(uuid, uuid, uuid) from public;
grant  execute on function core.cancel_makeup(uuid, uuid, uuid) to service_role;

-- ── 10. core.save_course_with_sessions v2 — preserve-by-id (replaces the replace-all) ─────────────────────
-- The old body did `delete from core.sessions where course_id = …` + reinsert on EVERY course edit; its
-- "safe: no downstream refs yet" comment went stale the moment core.attendance grew a cascading FK — a
-- title-only edit silently wiped the course's attendance history (and would now destroy make-ups too).
-- v2: payload sessions carry their `id`; carried rows are UPDATED IN PLACE (attendance/credits/makeups
-- survive), id-less rows are inserted, and only rows genuinely REMOVED from the payload are deleted — after
-- auto-cancelling their booked make-ups and restoring the credits (removing a lesson is the studio's action;
-- the parent's omluvenka must come back). The 12-arg overload is dropped (PostgREST named-arg dispatch),
-- so DB and app deploy together.
drop function if exists core.save_course_with_sessions(uuid, uuid, uuid, text, text, text, text, int, text[], uuid, jsonb, jsonb);

create or replace function core.save_course_with_sessions(
  p_tenant uuid, p_actor uuid, p_course_id uuid,
  p_title text, p_description text, p_kind text, p_status text,
  p_capacity int, p_tags text[], p_trainer_id uuid, p_extra jsonb,
  p_excuse_policy jsonb, p_sessions jsonb
) returns uuid language plpgsql security definer set search_path = core as $$
declare
  v_course_id uuid;
  v_removed   uuid[];
begin
  perform core.set_audit_actor(p_actor, 'staff');

  if p_course_id is null then
    insert into core.courses (tenant_id, title, description, kind, status, capacity, tags,
                              trainer_id, extra, excuse_policy, created_by)
    values (p_tenant, p_title, p_description, p_kind, p_status, p_capacity, coalesce(p_tags, '{}'),
            p_trainer_id, coalesce(p_extra, '{}'::jsonb), coalesce(p_excuse_policy, '{}'::jsonb), p_actor)
    returning id into v_course_id;
  else
    update core.courses
       set title = p_title, description = p_description, kind = p_kind, status = p_status,
           capacity = p_capacity, tags = coalesce(p_tags, '{}'),
           trainer_id = p_trainer_id, extra = coalesce(p_extra, '{}'::jsonb),
           excuse_policy = coalesce(p_excuse_policy, '{}'::jsonb)
     where id = p_course_id and tenant_id = p_tenant
    returning id into v_course_id;
    if v_course_id is null then
      raise exception 'course_not_found' using errcode = 'P0001';   -- → 422 via jsonError
    end if;

    -- rows the payload no longer carries (by id) are the REMOVED lessons.
    select coalesce(array_agg(s.id), '{}') into v_removed
      from core.sessions s
     where s.course_id = v_course_id
       and s.id not in (select (e->>'id')::uuid
                          from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) e
                         where nullif(e->>'id', '') is not null);

    if array_length(v_removed, 1) is not null then
      -- studio removed the lesson → give the omluvenka back, then release the bookings.
      update core.excusal_credits ec
         set status = 'active', redeemed_at = null
        from core.makeups mk
       where mk.session_id = any(v_removed) and mk.status = 'booked'
         and ec.id = mk.credit_id and ec.status = 'redeemed';
      update core.makeups
         set status = 'cancelled', cancelled_at = now()
       where session_id = any(v_removed) and status = 'booked';
      delete from core.sessions where id = any(v_removed);   -- attendance cascades — scoped, not replace-all
    end if;

    -- carried rows: update in place (only when something actually changed — no updated_at churn).
    update core.sessions s
       set starts_at = v.starts_at, duration_min = v.duration_min, location = v.location,
           trainer_id = v.trainer_id, sequence = v.sequence
      from (select (e->>'id')::uuid                as id,
                   (e->>'starts_at')::timestamptz  as starts_at,
                   (e->>'duration_min')::int       as duration_min,
                   coalesce(e->>'location', '')    as location,
                   nullif(e->>'trainer_id', '')::uuid as trainer_id,
                   (e->>'sequence')::int           as sequence
              from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) e
             where nullif(e->>'id', '') is not null) v
     where s.id = v.id and s.course_id = v_course_id and s.tenant_id = p_tenant
       and (s.starts_at, s.duration_min, s.location, s.trainer_id, s.sequence)
           is distinct from (v.starts_at, v.duration_min, v.location, v.trainer_id, v.sequence);
  end if;

  -- new rows: id-less payload entries (all of them for a fresh course). A stale id that no longer exists is
  -- treated as new too (the row was deleted meanwhile — recreate rather than silently drop).
  insert into core.sessions (tenant_id, course_id, starts_at, duration_min, location, trainer_id, sequence)
  select p_tenant, v_course_id,
         (e->>'starts_at')::timestamptz,
         (e->>'duration_min')::int,
         coalesce(e->>'location', ''),
         nullif(e->>'trainer_id', '')::uuid,
         (e->>'sequence')::int
  from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) e
  where nullif(e->>'id', '') is null
     or not exists (select 1 from core.sessions s
                    where s.id = (e->>'id')::uuid and s.course_id = v_course_id);

  return v_course_id;
end $$;

revoke execute on function core.save_course_with_sessions(uuid, uuid, uuid, text, text, text, text, int, text[], uuid, jsonb, jsonb, jsonb) from public;
grant  execute on function core.save_course_with_sessions(uuid, uuid, uuid, text, text, text, text, int, text[], uuid, jsonb, jsonb, jsonb) to service_role;
