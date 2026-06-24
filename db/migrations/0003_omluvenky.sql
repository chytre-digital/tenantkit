-- ILLUSTRATIVE MOCKUP — realizes docs/08-attendance-and-omluvenky.md (the signature subsystem) +
-- docs/03-data-model.md §6 (attendance & omluvenky tables). Migration 0003 of 3.
--
-- An absence becomes a makeup CREDIT ("omluvenka") whose EXPIRATION is set per course, redeemable into another
-- suitable session that has free capacity. The pure rules live in the app's domain/credits/* (issue/expiry/
-- redeem); THIS migration adds the storage + the ★ atomic redemption RPC `redeem_credit_into_session` that the
-- pure match/expiry logic is mirrored into for the money-time, concurrency-safe path (doc 08 §6).

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ enums (doc 03 §6)                                                                                          │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
do $$ begin create type public.attendance_state as enum ('present', 'excused', 'absent', 'unmarked'); exception when duplicate_object then null; end $$;
do $$ begin create type public.excuse_source    as enum ('staff', 'self');                            exception when duplicate_object then null; end $$;
do $$ begin create type public.excuse_status    as enum ('recorded', 'credit_issued');                exception when duplicate_object then null; end $$;
do $$ begin create type public.credit_status    as enum ('active', 'redeemed', 'expired', 'cancelled');exception when duplicate_object then null; end $$;
do $$ begin create type public.makeup_status    as enum ('booked', 'cancelled', 'attended');          exception when duplicate_object then null; end $$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ tables (doc 03 §6)                                                                                         │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
-- public.attendance — per session × participant. unique(session_id, participant_id) makes record upserts work.
create table if not exists public.attendance (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  session_id     uuid not null references public.sessions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  enrollment_id  uuid references public.enrollments(id),
  state          public.attendance_state not null,           -- present | excused | absent | unmarked
  marked_by      uuid,
  marked_at      timestamptz not null default now(),
  unique (session_id, participant_id)
);
create index if not exists attendance_session_idx     on public.attendance(session_id);
create index if not exists attendance_participant_idx on public.attendance(participant_id);

-- public.excuses — the act of excusing ("omluvení"). credit_id FK is added after public.credits exists.
create table if not exists public.excuses (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  session_id     uuid not null references public.sessions(id),
  participant_id uuid not null references public.participants(id),
  enrollment_id  uuid references public.enrollments(id),
  source         public.excuse_source not null default 'staff',   -- staff (attendance) | self (portal)
  status         public.excuse_status not null default 'recorded',-- recorded | credit_issued
  credit_id      uuid,                                            -- → public.credits(id) (FK added below)
  created_at     timestamptz not null default now(),
  unique (session_id, participant_id)
);

-- public.credits — the makeup credit ("omluvenka"). THE TOKEN whose validity a course configures (doc 08 §5).
create table if not exists public.credits (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  participant_id     uuid not null references public.participants(id) on delete cascade,
  source_excuse_id   uuid references public.excuses(id),
  source_course_id   uuid references public.courses(id),
  source_session_id  uuid references public.sessions(id),
  tags               text[] not null default '{}',             -- snapshotted from source course at issue (doc 08 §4)
  -- redeem-match rules snapshotted from the source course's excuse_policy.redeemMatch (doc 08 §6):
  match_age          boolean not null default false,           -- ageMatchRequired
  match_tags         boolean not null default false,           -- sameTagsRequired
  match_cross_course boolean not null default true,            -- crossCourse
  -- EXPIRY (two physical representations, doc 08 §5):
  expires_at         timestamptz,                              -- ttl / course_end collapse to a timestamp
  valid_window_ids   uuid[] not null default '{}',             -- windows mode: redeemable within these
  status             public.credit_status not null default 'active',  -- active | redeemed | expired | cancelled
  redeemed_makeup_id uuid,                                     -- → public.makeups(id) (FK added below)
  created_at         timestamptz not null default now(),
  redeemed_at        timestamptz,
  deleted_at         timestamptz
);
-- hot paths (doc 03 §8): portal balance + studio liability.
create index if not exists credits_active_by_participant on public.credits(participant_id) where status = 'active';
create index if not exists credits_tenant_status         on public.credits(tenant_id, status);

-- public.makeups — a session booked with a credit ("náhrada"). One credit → one makeup (doc 08 §6 step 4).
create table if not exists public.makeups (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  credit_id      uuid not null references public.credits(id),
  participant_id uuid not null references public.participants(id),
  session_id     uuid not null references public.sessions(id),  -- the makeup target
  status         public.makeup_status not null default 'booked',-- booked | cancelled | attended
  booked_by      uuid,                -- guardian or staff
  created_at     timestamptz not null default now(),
  cancelled_at   timestamptz
);
create index if not exists makeups_session_active on public.makeups(session_id) where status = 'booked';

-- append-only audit of credit mutations (extend/retag/cancel/grant) — doc 03 §6, doc 08 §8.
create table if not exists public.credit_audit (
  id            uuid primary key default gen_random_uuid(),
  credit_id     uuid not null references public.credits(id) on delete cascade,
  actor_user_id uuid,
  action        text not null,                                 -- extend | retag | cancel | grant | redeem | attendance_corrected
  field         text,
  before        jsonb,
  after         jsonb,
  at            timestamptz not null default now()
);

-- deferred cross-table FKs (now that both targets exist).
do $$ begin
  alter table public.excuses add constraint excuses_credit_fk    foreign key (credit_id)          references public.credits(id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.credits add constraint credits_makeup_fk    foreign key (redeemed_makeup_id) references public.makeups(id);
exception when duplicate_object then null; end $$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ helper: effective capacity of a session (doc 08 §6 step 3 — capacity_override ?? course.capacity)          │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
create or replace function public.effective_capacity(p_session uuid)
  returns int language sql stable
  set search_path = public, core as $$
  select coalesce(s.capacity_override, c.capacity)
  from public.sessions s join public.courses c on c.id = s.course_id
  where s.id = p_session
$$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ ★ redeem_credit_into_session — the atomic redemption RPC (doc 08 §6). SECURITY DEFINER plpgsql.           │
-- │   Validates guardian_can_act + isRedeemable (status/expiry/windows) → applies match rules → SELECT … FOR   │
-- │   UPDATE capacity check vs effective capacity → inserts the makeup → flips the credit to redeemed. Raises  │
-- │   the documented codes (CREDIT_EXPIRED, SESSION_FULL, …) via RAISE so the app maps them (doc 02 §5).       │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
create or replace function public.redeem_credit_into_session(p_credit uuid, p_session uuid)
  returns uuid
  language plpgsql security definer
  set search_path = public, core as $$
declare
  v_credit   public.credits%rowtype;
  v_session  public.sessions%rowtype;
  v_target   public.courses%rowtype;       -- the TARGET session's course
  v_dob      date;
  v_age_mo   int;
  v_today    date := (now() at time zone 'utc')::date;
  v_count    int;
  v_capacity int;
  v_window_ok boolean;
  v_makeup   uuid;
begin
  -- Lock the credit row first so two concurrent redemptions of the SAME credit serialize (one wins).
  select * into v_credit from public.credits where id = p_credit for update;
  if not found then
    raise exception 'CREDIT_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- (1a) The credit belongs to a participant the caller may act for (doc 08 §6 step 1, doc 04 §7).
  if not core.guardian_can_act(v_credit.participant_id) then
    raise exception 'NOT_A_GUARDIAN' using errcode = 'P0001';
  end if;

  -- (1b) isRedeemableNow (doc 08 §5): status active + not soft-deleted + within expiry + within a window.
  if v_credit.status <> 'active' or v_credit.deleted_at is not null then
    raise exception 'CREDIT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_credit.expires_at is not null and now() > v_credit.expires_at then
    raise exception 'CREDIT_EXPIRED' using errcode = 'P0001';
  end if;
  if array_length(v_credit.valid_window_ids, 1) is not null then
    -- some named window must cover today (starts_on ≤ today ≤ ends_on).
    select exists (
      select 1 from public.validity_windows w
      where w.id = any (v_credit.valid_window_ids)
        and w.deleted_at is null
        and v_today between w.starts_on and w.ends_on
    ) into v_window_ok;
    if not v_window_ok then
      raise exception 'CREDIT_EXPIRED' using errcode = 'P0001';   -- outside every valid window → not redeemable
    end if;
  end if;

  -- Load the target session + its course (must be a scheduled session).
  select * into v_session from public.sessions where id = p_session;
  if not found or v_session.status <> 'scheduled' then
    raise exception 'SESSION_NOT_BOOKABLE' using errcode = 'P0001';
  end if;
  select * into v_target from public.courses where id = v_session.course_id;

  -- (2) MATCH RULES from the credit (snapshotted from the SOURCE course) vs the TARGET course (doc 08 §6 step 2).
  -- crossCourse === false → target must be the same course as the source.
  if v_credit.match_cross_course = false
     and v_credit.source_course_id is not null
     and v_target.id <> v_credit.source_course_id then
    raise exception 'CROSS_COURSE_FORBIDDEN' using errcode = 'P0001';
  end if;

  -- ageMatchRequired → participant's age (months, from date_of_birth) ∈ target [age_min_months, age_max_months].
  if v_credit.match_age then
    select date_of_birth into v_dob from public.participants where id = v_credit.participant_id;
    if v_dob is null then
      raise exception 'AGE_MISMATCH' using errcode = 'P0001';
    end if;
    v_age_mo := (extract(year from age(v_dob)) * 12 + extract(month from age(v_dob)))::int;
    if (v_target.age_min_months is not null and v_age_mo < v_target.age_min_months)
       or (v_target.age_max_months is not null and v_age_mo > v_target.age_max_months) then
      raise exception 'AGE_MISMATCH' using errcode = 'P0001';
    end if;
  end if;

  -- sameTagsRequired → target course tags ∩ credit.tags ≠ ∅.
  if v_credit.match_tags then
    if not exists (
      select 1 from public.course_tags ct
      where ct.course_id = v_target.id and ct.tag = any (v_credit.tags)
    ) then
      raise exception 'TAG_MISMATCH' using errcode = 'P0001';
    end if;
  end if;

  -- (3) CAPACITY (atomic): take a row lock on the TARGET SESSION first, so concurrent redemptions into the same
  -- session serialize on it — the loser blocks here until the winner commits, then re-reads the now-updated
  -- count and gets SESSION_FULL (doc 08 §6 step 3, §11; the generalized overbooking guard). Locking the session
  -- row (rather than `count(*) … FOR UPDATE`, which Postgres forbids) is what prevents two guardians grabbing the
  -- last seat even when the session currently has zero bookings.
  perform 1 from public.sessions where id = p_session for update;

  v_capacity := public.effective_capacity(p_session);
  v_count :=
    (select count(*) from public.makeups mk
       where mk.session_id = p_session and mk.status = 'booked')
    +
    (select count(*) from public.enrollments e
       where e.course_id = v_session.course_id and e.status = 'active');

  if v_count >= v_capacity then
    raise exception 'SESSION_FULL' using errcode = 'P0001';
  end if;

  -- (4) Insert the makeup (booked) and flip the credit to redeemed. One credit → one makeup.
  insert into public.makeups (tenant_id, credit_id, participant_id, session_id, status, booked_by)
  values (v_credit.tenant_id, v_credit.id, v_credit.participant_id, p_session, 'booked', core.current_user_id())
  returning id into v_makeup;

  update public.credits
     set status = 'redeemed', redeemed_makeup_id = v_makeup, redeemed_at = now()
   where id = v_credit.id;

  -- append-only audit (doc 08 §8) + transactional outbox event in the SAME tx (doc 09 §5: no lost/phantom events).
  insert into public.credit_audit (credit_id, actor_user_id, action, before, after)
  values (v_credit.id, core.current_user_id(), 'redeem',
          jsonb_build_object('status', 'active'),
          jsonb_build_object('status', 'redeemed', 'makeup_id', v_makeup));

  insert into core.outbox (tenant_id, event_type, payload)
  values (v_credit.tenant_id, 'credit.redeemed',
          jsonb_build_object('creditId', v_credit.id, 'makeupId', v_makeup, 'sessionId', p_session));

  return v_makeup;
end;
$$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ trigger: emit core.outbox 'credit.issued' when a credit is minted (doc 08 §4, doc 09 §5.1)                 │
-- │ NOTE: the record-attendance use-case already emits 'credit.issued' explicitly; this trigger is the         │
-- │ belt-and-suspenders DB-side guarantee so a credit minted by ANY path (grant, auto-excuse on cancellation,  │
-- │ doc 08 §9) still fans out. Idempotency on (event_type, creditId) is handled by the dispatcher.             │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
create or replace function public.emit_credit_issued()
  returns trigger language plpgsql
  set search_path = public, core as $$
  begin
    insert into core.outbox (tenant_id, event_type, payload)
    values (new.tenant_id, 'credit.issued',
            jsonb_build_object('creditId', new.id, 'participantId', new.participant_id,
                               'sourceCourseId', new.source_course_id, 'expiresAt', new.expires_at));
    return new;
  end;
$$;
drop trigger if exists credit_issued_outbox on public.credits;
create trigger credit_issued_outbox after insert on public.credits
  for each row when (new.status = 'active') execute function public.emit_credit_issued();

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ RLS — enabled on every table; default deny (doc 03 §7)                                                     │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
alter table public.attendance    enable row level security;
alter table public.excuses       enable row level security;
alter table public.credits       enable row level security;
alter table public.makeups       enable row level security;
alter table public.credit_audit  enable row level security;

-- attendance: staff read = member; staff write = coach+ ; coach 'own' through the session's course (doc 04 §4).
create policy attendance_read on public.attendance for select using (core.is_member_of(tenant_id));
create policy attendance_write_any on public.attendance for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
create policy attendance_write_own on public.attendance for all      -- attendance:record own-scope (doc 04 §4)
  using (
    core.is_member_of(tenant_id, 'coach')
    and exists (
      select 1 from public.sessions s
      join public.coach_assignments ca on ca.course_id = s.course_id
      where s.id = attendance.session_id and ca.user_id = core.current_user_id()
    )
  )
  with check (
    core.is_member_of(tenant_id, 'coach')
    and exists (
      select 1 from public.sessions s
      join public.coach_assignments ca on ca.course_id = s.course_id
      where s.id = attendance.session_id and ca.user_id = core.current_user_id()
    )
  );
-- family reads their participant's attendance (the portal docházka view).
create policy attendance_family_read on public.attendance for select using (core.guardian_can_act(participant_id));

-- excuses: staff manage (coach+); family reads their participant's excuses; self-excuse insert by family is
-- routed through a use-case (createSelfExcuse, doc 08 §3) under the same guardian predicate.
create policy excuses_staff_rw on public.excuses for all
  using (core.is_member_of(tenant_id, 'coach')) with check (core.is_member_of(tenant_id, 'coach'));
create policy excuses_family_read on public.excuses for select using (core.guardian_can_act(participant_id));
create policy excuses_family_insert on public.excuses for insert
  with check (source = 'self' and core.guardian_can_act(participant_id));

-- credits: staff manage = admin+ (credits:manage/grant, doc 04 §3); coach 'own' read through the source course;
-- FAMILY read their participant's credits (the portal balance, doc 03 §7 example 2).
create policy credits_staff_read on public.credits for select using (core.is_member_of(tenant_id));
create policy credits_staff_write on public.credits for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
create policy credits_family_read on public.credits for select using (core.guardian_can_act(participant_id));

-- makeups: staff read = member, write = coach+ (e.g. marking attended); FAMILY read their participant's; the
-- booking itself happens through redeem_credit_into_session (SECURITY DEFINER), not a direct insert.
create policy makeups_staff_read on public.makeups for select using (core.is_member_of(tenant_id));
create policy makeups_staff_write on public.makeups for all
  using (core.is_member_of(tenant_id, 'coach')) with check (core.is_member_of(tenant_id, 'coach'));
create policy makeups_family_read on public.makeups for select using (core.guardian_can_act(participant_id));

-- credit_audit: append-only, readable by admin+ (the participant-profile modal's history, doc 08 §8).
create policy credit_audit_read on public.credit_audit for select
  using (exists (select 1 from public.credits c where c.id = credit_audit.credit_id and core.is_member_of(c.tenant_id, 'admin')));
