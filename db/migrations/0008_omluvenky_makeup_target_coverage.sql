-- SHIPPED REFERENCE — make-up target-day coverage as shipped in terminar (2026-07), extending the 0006/0007
-- omluvenky subset (docs/08 §14 "Target-day coverage"). Verbatim source of this file:
-- terminar/supabase/migrations/20260706160000_core_makeup_target_coverage.sql.
--
-- Omluvenka expiry now bounds the TARGET lesson's date, not just the booking moment. "Platí do 5. 8." must
-- mean the credit books lessons THROUGH 5. 8. (Prague calendar day, inclusive — same convention as the token
-- end-of-day) and never a lesson on 6. 8., even when the booking itself happens while the credit is valid.
-- Previously the FIFO pick gated only redemption time (expires_at >= now()), so a credit could book any
-- future session inside the portal's horizon.
--
-- book_makeup v2 (only two changes from 20260706130000 §8):
--   • the FIFO pick additionally requires the credit to COVER the target session's Prague day
--     ((v_starts at tz)::date <= (expires_at at tz)::date) — FIFO now means "the soonest-expiring credit
--     that covers the target". Day-level (not timestamp) so a ttl credit stamped 5.8. 18:30 still books the
--     5.8. 21:00 lesson — matching the displayed "platí do 5. 8.".
--   • distinct error: when a now-redeemable credit exists but none covers the target's day, raise
--     'credit_expires_before_session' (instead of the misleading 'no_credit') so the portal can explain.
-- TS mirror: reservation-core credits creditCoversSession (0.3.0); the portal additionally hides non-covered
-- slots per participant client-side (MakeupsTab) — dual enforcement as everywhere else (docs/08 §13).

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

  -- FIFO credit pick, locked against double-spend. A credit qualifies when it is redeemable NOW (live +
  -- inclusive: expires_at >= now()) AND its validity COVERS the target lesson's Prague day.
  select id into v_credit from core.excusal_credits
   where tenant_id = p_tenant and participant_id = p_participant and status = 'active'
     and (expires_at is null or expires_at >= now())
     and (expires_at is null
          or (v_starts at time zone 'Europe/Prague')::date <= (expires_at at time zone 'Europe/Prague')::date)
   order by expires_at asc nulls last, issued_at asc
   limit 1
   for update;
  if v_credit is null then
    -- Valid omluvenka in hand, target lesson past its validity → say THAT, not "no credit".
    if exists (select 1 from core.excusal_credits
                where tenant_id = p_tenant and participant_id = p_participant and status = 'active'
                  and (expires_at is null or expires_at >= now())) then
      raise exception 'credit_expires_before_session' using errcode = 'P0001';
    end if;
    raise exception 'no_credit' using errcode = 'P0001';
  end if;

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
