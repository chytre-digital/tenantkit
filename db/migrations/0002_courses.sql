-- ILLUSTRATIVE MOCKUP — realizes docs/03-data-model.md §4 (course domain) + §5 (enrollment domain) +
-- §7 (RLS predicate families) and docs/04-roles-and-permissions.md §4 (own vs any → USING clause).
--
-- Schema `public` = the Termínář app domain (courses, sessions, enrollments). Migration 0002 of 3.
-- RLS pattern (doc 03 §7, doc 04 §4):
--   • STAFF  read  = any member          → core.is_member_of(tenant_id)
--   • STAFF  write = role-gated          → core.is_member_of(tenant_id, 'coach'|'admin')
--   • COACH  'own' = assigned to the row → AND exists(coach_assignments …)  (1–2 examples shown)
--   • FAMILY        = guardian link      → core.guardian_can_act(participant_id)
--   • ANON  catalogue                    → to anon using (show_on_public and status='active')

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ enums (doc 03 §4, §5)                                                                                      │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
do $$ begin create type public.course_kind        as enum ('one_time', 'multi_session');                          exception when duplicate_object then null; end $$;
do $$ begin create type public.course_status      as enum ('draft', 'active', 'completed', 'cancelled');          exception when duplicate_object then null; end $$;
do $$ begin create type public.reg_mode           as enum ('open', 'staff_only');                                  exception when duplicate_object then null; end $$;
do $$ begin create type public.session_status     as enum ('scheduled', 'cancelled');                              exception when duplicate_object then null; end $$;
do $$ begin create type public.field_type         as enum ('yes_no', 'text', 'options', 'number', 'date');         exception when duplicate_object then null; end $$;
do $$ begin create type public.application_status as enum ('pending', 'approved', 'rejected');                     exception when duplicate_object then null; end $$;
do $$ begin create type public.enrollment_source  as enum ('application', 'staff', 'makeup');                      exception when duplicate_object then null; end $$;
do $$ begin create type public.enrollment_status  as enum ('active', 'cancelled', 'completed');                    exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_state      as enum ('none', 'unpaid', 'paid', 'waived', 'refunded');        exception when duplicate_object then null; end $$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ participants                                                                                                │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
-- public.participants — the person attending. Age (months for babies, years for kids) is COMPUTED from
-- date_of_birth, never stored (doc 03 §4).
create table if not exists public.participants (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  full_name     text not null,
  date_of_birth date,                                        -- drives age-based course matching (doc 08 §6)
  note          text,                                         -- staff note (the profile modal's textarea)
  custom        jsonb not null default '{}',                  -- denormalized snapshot of custom field values
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Now that public.participants exists, wire the deferred FK from core.guardianships (declared in 0001).
do $$ begin
  alter table core.guardianships
    add constraint guardianships_participant_fk
    foreign key (participant_id) references public.participants(id) on delete cascade;
exception when duplicate_object then null; end $$;

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ courses + sessions                                                                                         │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
-- public.courses — the long-term offering ("kurz"). excuse_policy jsonb is specced in doc 08 (the omluvenka
-- expiry/redeem policy); surfaced as the course editor's Omluvenky tab (doc 06 §8).
create table if not exists public.courses (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  title             text not null,
  description       text,
  kind              public.course_kind   not null default 'multi_session',  -- one_time | multi_session
  status            public.course_status not null default 'draft',          -- draft | active | completed | cancelled
  capacity          int not null check (capacity >= 1),
  age_min_months    int,
  age_max_months    int,                                     -- nullable age band for auto-matching
  registration_mode public.reg_mode not null default 'open', -- open | staff_only
  show_on_public    boolean not null default false,          -- listed on the public catalogue?
  excuse_policy     jsonb not null default '{}',             -- { creditsEnabled, expiry:{mode,…}, selfExcuseDeadlineHours, redeemMatch, tags[] } (doc 08)
  primary_coach_id  uuid,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz                              -- soft delete (history matters, doc 03 §1)
);

-- public.sessions — one lesson ("lekce"). No recurrence rule is stored — the generator emits an explicit,
-- editable list (doc 03 §4, doc 06 §5).
create table if not exists public.sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  starts_at         timestamptz not null,
  duration_min      int not null check (duration_min >= 1),
  location          text,
  sequence          int not null,                            -- 1-based order within the course
  capacity_override int,                                     -- null → inherit course.capacity
  status            public.session_status not null default 'scheduled',  -- scheduled | cancelled
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists sessions_course_starts on public.sessions(course_id, starts_at);
create index if not exists sessions_tenant_starts on public.sessions(tenant_id, starts_at);

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ supporting tables (doc 03 §4)                                                                              │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
create table if not exists public.course_tags (
  course_id uuid not null references public.courses(id) on delete cascade,
  tag       text not null,                                   -- freeform; used by credit redemption matching
  primary key (course_id, tag)
);
-- coaches on a course (own-scope RLS reaches through this).
create table if not exists public.coach_assignments (
  course_id  uuid not null references public.courses(id) on delete cascade,
  user_id    uuid not null,
  is_primary boolean not null default false,
  primary key (course_id, user_id)
);
-- named expiry windows (doc 08 §5 `windows` mode).
create table if not exists public.validity_windows (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  name       text not null,
  starts_on  date not null,
  ends_on    date not null,
  deleted_at timestamptz
);
create table if not exists public.custom_field_definitions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  name           text not null,
  field_type     public.field_type not null,
  allowed_values text[],
  display_order  int not null default 0
);
create table if not exists public.course_field_assignments (
  course_id uuid not null references public.courses(id) on delete cascade,
  field_id  uuid not null references public.custom_field_definitions(id) on delete cascade,
  required  boolean not null default false,
  primary key (course_id, field_id)
);

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ enrollment domain (doc 03 §5)                                                                              │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
-- public.applications — a submitted public form ("přihláška"); no account required yet.
create table if not exists public.applications (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  course_id          uuid references public.courses(id),
  desired_session_id uuid references public.sessions(id),
  child_name         text not null,
  child_dob          date,
  guardian_name      text not null,
  guardian_email     text not null,
  guardian_phone     text,
  source             text,                                   -- "how did you hear about us"
  custom             jsonb not null default '{}',
  gdpr_consent_at    timestamptz not null,
  status             public.application_status not null default 'pending',
  safe_link_token    uuid not null default gen_random_uuid(),-- emailed confirm/track link
  decided_by         uuid,
  decided_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists applications_tenant_status on public.applications(tenant_id, status);

-- public.enrollments — confirmed participant ↔ course ("zápis").
create table if not exists public.enrollments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  source         public.enrollment_source not null,          -- application | staff | makeup
  application_id uuid references public.applications(id),
  status         public.enrollment_status not null default 'active',  -- active | cancelled | completed
  payment_status public.payment_state not null default 'none',        -- payments plugin updates (doc 09)
  enrolled_at    timestamptz not null default now(),
  cancelled_at   timestamptz,
  cancel_reason  text
);
-- no double ACTIVE enrollment (doc 03 §5, §8 partial-unique).
create unique index if not exists enrollments_one_active
  on public.enrollments(course_id, participant_id) where status = 'active';
create index if not exists enrollments_active_by_course
  on public.enrollments(course_id) where status = 'active';

create table if not exists public.participant_field_values (
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  field_id      uuid not null references public.custom_field_definitions(id) on delete cascade,
  value         text,
  primary key (enrollment_id, field_id)
);

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ updated_at triggers (doc 03 §1)                                                                            │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
drop trigger if exists set_updated_at on public.participants;
create trigger set_updated_at before update on public.participants for each row execute function core.set_updated_at();
drop trigger if exists set_updated_at on public.courses;
create trigger set_updated_at before update on public.courses      for each row execute function core.set_updated_at();
drop trigger if exists set_updated_at on public.sessions;
create trigger set_updated_at before update on public.sessions     for each row execute function core.set_updated_at();

-- ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────╮
-- │ RLS — enabled on every table; default deny (doc 03 §7)                                                     │
-- ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────╯
alter table public.participants              enable row level security;
alter table public.courses                   enable row level security;
alter table public.sessions                  enable row level security;
alter table public.course_tags               enable row level security;
alter table public.coach_assignments         enable row level security;
alter table public.validity_windows          enable row level security;
alter table public.custom_field_definitions  enable row level security;
alter table public.course_field_assignments  enable row level security;
alter table public.applications              enable row level security;
alter table public.enrollments               enable row level security;
alter table public.participant_field_values  enable row level security;

-- participants: staff read = member; staff write = coach+ (any); FAMILY read = guardian link (doc 04 §7).
create policy participants_staff_read  on public.participants for select using (core.is_member_of(tenant_id));
create policy participants_staff_write on public.participants for all
  using (core.is_member_of(tenant_id, 'coach')) with check (core.is_member_of(tenant_id, 'coach'));
create policy participants_family_read on public.participants for select using (core.guardian_can_act(id));

-- courses: read = any member; write_any = admin+; write_own = coach assigned to THIS course (doc 04 §4 verbatim).
-- Multiple FOR-policies are OR-ed by Postgres, so an owner passes via _any, a coach only via _own.
create policy courses_read on public.courses for select using (core.is_member_of(tenant_id));
create policy courses_write_any on public.courses for all
  using      (core.is_member_of(tenant_id, 'admin'))
  with check (core.is_member_of(tenant_id, 'admin'));
create policy courses_write_own on public.courses for update    -- ★ a coach 'own' policy via coach_assignments
  using (
    core.is_member_of(tenant_id, 'coach')
    and exists (select 1 from public.coach_assignments ca where ca.course_id = courses.id and ca.user_id = core.current_user_id())
  )
  with check (
    core.is_member_of(tenant_id, 'coach')
    and exists (select 1 from public.coach_assignments ca where ca.course_id = courses.id and ca.user_id = core.current_user_id())
  );
-- ANON public catalogue: only when show_on_public AND status='active' (doc 03 §7, doc 06 §8).
create policy courses_public_catalogue on public.courses for select
  to anon using (show_on_public and status = 'active');

-- sessions: read = member (or anon for a public course's slots); write_any = admin+; write_own = coach via the
-- session's COURSE assignment (doc 04 §4 — 'own' resolves through the course).
create policy sessions_read on public.sessions for select using (core.is_member_of(tenant_id));
create policy sessions_write_any on public.sessions for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
create policy sessions_write_own on public.sessions for all     -- ★ second coach 'own' policy (through course)
  using (
    core.is_member_of(tenant_id, 'coach')
    and exists (select 1 from public.coach_assignments ca where ca.course_id = sessions.course_id and ca.user_id = core.current_user_id())
  )
  with check (
    core.is_member_of(tenant_id, 'coach')
    and exists (select 1 from public.coach_assignments ca where ca.course_id = sessions.course_id and ca.user_id = core.current_user_id())
  );
create policy sessions_public_read on public.sessions for select
  to anon using (exists (select 1 from public.courses c where c.id = sessions.course_id and c.show_on_public and c.status = 'active'));

-- course_tags: read by member or anon (catalogue chips); written with the course (admin+/coach own).
create policy course_tags_read on public.course_tags for select
  using (exists (select 1 from public.courses c where c.id = course_tags.course_id and core.is_member_of(c.tenant_id)));
create policy course_tags_read_anon on public.course_tags for select
  to anon using (exists (select 1 from public.courses c where c.id = course_tags.course_id and c.show_on_public and c.status = 'active'));
create policy course_tags_write on public.course_tags for all
  using (exists (select 1 from public.courses c where c.id = course_tags.course_id and core.is_member_of(c.tenant_id, 'coach')))
  with check (exists (select 1 from public.courses c where c.id = course_tags.course_id and core.is_member_of(c.tenant_id, 'coach')));

-- coach_assignments: read = member; write = admin+ (courses:assign-coach is 'any' only, doc 04 §3).
create policy coach_assignments_read on public.coach_assignments for select
  using (exists (select 1 from public.courses c where c.id = coach_assignments.course_id and core.is_member_of(c.tenant_id)));
create policy coach_assignments_write on public.coach_assignments for all
  using (exists (select 1 from public.courses c where c.id = coach_assignments.course_id and core.is_member_of(c.tenant_id, 'admin')))
  with check (exists (select 1 from public.courses c where c.id = coach_assignments.course_id and core.is_member_of(c.tenant_id, 'admin')));

-- validity_windows / custom fields: settings-class — read by member, managed by admin+ (settings:manage).
create policy validity_windows_read on public.validity_windows for select using (core.is_member_of(tenant_id));
create policy validity_windows_write on public.validity_windows for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
create policy custom_fields_read on public.custom_field_definitions for select using (core.is_member_of(tenant_id));
create policy custom_fields_write on public.custom_field_definitions for all
  using (core.is_member_of(tenant_id, 'admin')) with check (core.is_member_of(tenant_id, 'admin'));
create policy course_field_assignments_rw on public.course_field_assignments for all
  using (exists (select 1 from public.courses c where c.id = course_field_assignments.course_id and core.is_member_of(c.tenant_id, 'coach')))
  with check (exists (select 1 from public.courses c where c.id = course_field_assignments.course_id and core.is_member_of(c.tenant_id, 'coach')));

-- applications: staff read/decide = member (own resolves through the requested course for a coach); ANON may
-- INSERT a new application (the public form has no session) — gated to a real, publicly-registrable course.
create policy applications_staff_read on public.applications for select using (core.is_member_of(tenant_id));
create policy applications_staff_write on public.applications for all
  using (core.is_member_of(tenant_id, 'staff')) with check (core.is_member_of(tenant_id, 'staff'));
create policy applications_public_insert on public.applications for insert to anon
  with check (
    exists (
      select 1 from public.courses c
      where c.id = applications.course_id
        and c.tenant_id = applications.tenant_id
        and c.registration_mode = 'open'
        and c.status = 'active'
    )
  );

-- enrollments: staff read = member, write = coach+ (any); FAMILY read = guardian link (doc 04 §7).
create policy enrollments_staff_read on public.enrollments for select using (core.is_member_of(tenant_id));
create policy enrollments_staff_write on public.enrollments for all
  using (core.is_member_of(tenant_id, 'coach')) with check (core.is_member_of(tenant_id, 'coach'));
create policy enrollments_family_read on public.enrollments for select using (core.guardian_can_act(participant_id));

-- participant_field_values: follow the enrollment's access (member read; coach+ write).
create policy participant_field_values_read on public.participant_field_values for select
  using (exists (select 1 from public.enrollments e where e.id = participant_field_values.enrollment_id and core.is_member_of(e.tenant_id)));
create policy participant_field_values_write on public.participant_field_values for all
  using (exists (select 1 from public.enrollments e where e.id = participant_field_values.enrollment_id and core.is_member_of(e.tenant_id, 'coach')))
  with check (exists (select 1 from public.enrollments e where e.id = participant_field_values.enrollment_id and core.is_member_of(e.tenant_id, 'coach')));
