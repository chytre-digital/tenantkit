-- ILLUSTRATIVE MOCKUP — demo seed for "Plavecká škola Delfínek" (a swimming school), exercising docs 03/04/08.
--
-- Runnable-looking against the schema from migrations 0001–0003. It seeds:
--   • a tenant (slug 'delfinek', tier 'studio') with omluvenka defaults
--   • an owner membership + a guardian account with one child participant + an active enrollment
--   • 2–3 courses with age bands IN MONTHS + sessions (one per course shown), incl. an omluvenka policy
--   • one EXCUSED attendance that issued an ACTIVE credit (the signature flow, doc 08 §1)
--
-- In a real deployment the identity provider (Supabase Auth, Auth.js, a custom IdP, …) owns user accounts; core
-- references them by uuid with NO database FK. Here we seed core.profiles directly with fixed uuids — the demo
-- is self-contained without any vendor auth schema.

-- ── fixed ids (so re-running is predictable) ────────────────────────────────────────────────────────────────
-- All ids are valid hex uuids (only 0-9a-f) so the demo is genuinely runnable.
\set tenant_id      '00000000-0000-0000-0000-0000000000d1'
\set owner_uid      '00000000-0000-0000-0000-0000000000a1'
\set guardian_uid   '00000000-0000-0000-0000-0000000000a2'
\set child_id       '00000000-0000-0000-0000-0000000000c1'
\set course_baby    '00000000-0000-0000-0000-00000000cb01'
\set course_toddler '00000000-0000-0000-0000-00000000cb02'
\set course_prek    '00000000-0000-0000-0000-00000000cb03'
\set sess_baby_past '00000000-0000-0000-0000-000000005001'
\set sess_baby_next '00000000-0000-0000-0000-000000005002'
\set enroll_id      '00000000-0000-0000-0000-0000000e0001'
\set excuse_id      '00000000-0000-0000-0000-00000000e501'
\set credit_id      '00000000-0000-0000-0000-00000000c401'
\set window_jaro    '00000000-0000-0000-0000-00000000aa01'

-- (identities owner_uid / guardian_uid are created by your IdP in production; core.profiles below anchors them by uuid)

-- ── tenant + owner (would normally go through core.create_tenant_with_owner; explicit here for clarity) ──────
insert into core.tenants (id, slug, name, tier, default_locale, settings)
values (
  :'tenant_id', 'delfinek', 'Plavecká škola Delfínek', 'studio', 'cs',
  -- tenant-level omluvenka defaults a new course inherits (doc 08 §12):
  jsonb_build_object('excuseDefaults', jsonb_build_object(
    'creditsEnabled', true,
    'expiry', jsonb_build_object('mode', 'ttl', 'ttlDays', 30),
    'selfExcuseDeadlineHours', 24,
    'redeemMatch', jsonb_build_object('ageMatchRequired', true, 'sameTagsRequired', true, 'crossCourse', false)
  ))
)
on conflict (id) do nothing;

insert into core.profiles (id, full_name, locale, phone) values
  (:'owner_uid',    'Jana Šéfová',  'cs', '+420777000111'),
  (:'guardian_uid', 'Petr Rodič',   'cs', '+420777000222')
on conflict (id) do nothing;

insert into core.memberships (user_id, tenant_id, role)
values (:'owner_uid', :'tenant_id', 'owner')
on conflict (user_id, tenant_id) do nothing;

-- studio is on a paid tier → enable an entitled plugin (ratings is studio-tier, doc 09 §3.2).
insert into core.plugin_activations (tenant_id, plugin_id, is_enabled, enabled_at)
values (:'tenant_id', 'ratings', true, now())
on conflict (tenant_id, plugin_id) do nothing;

-- ── a named validity window (so the 'windows' expiry mode is demonstrable) ──────────────────────────────────
insert into public.validity_windows (id, tenant_id, name, starts_on, ends_on)
values (:'window_jaro', :'tenant_id', 'Jaro 2026', '2026-03-01', '2026-05-31')
on conflict (id) do nothing;

-- ── courses (age bands IN MONTHS) + their omluvenka policies ─────────────────────────────────────────────────
-- Kojenci 3–12 m — TTL 30 days; baby tag; redeem requires age + tag, same course only.
insert into public.courses
  (id, tenant_id, title, description, kind, status, capacity, age_min_months, age_max_months,
   registration_mode, show_on_public, excuse_policy, primary_coach_id, created_by)
values (
  :'course_baby', :'tenant_id', 'Plavání kojenci', 'Plavání pro miminka 3–12 měsíců',
  'multi_session', 'active', 8, 3, 12, 'open', true,
  jsonb_build_object(
    'creditsEnabled', true,
    'expiry', jsonb_build_object('mode', 'ttl', 'ttlDays', 30),
    'selfExcuseDeadlineHours', 24,
    'maxCreditsPerEnrollment', 5,
    'redeemMatch', jsonb_build_object('ageMatchRequired', true, 'sameTagsRequired', true, 'crossCourse', false)
  ),
  :'owner_uid', :'owner_uid'
)
on conflict (id) do nothing;

-- Batolata 12–36 m — course_end expiry; toddler tag; cross-course allowed.
insert into public.courses
  (id, tenant_id, title, description, kind, status, capacity, age_min_months, age_max_months,
   registration_mode, show_on_public, excuse_policy, primary_coach_id, created_by)
values (
  :'course_toddler', :'tenant_id', 'Plavání batolata', 'Plavání pro batolata 1–3 roky',
  'multi_session', 'active', 10, 12, 36, 'open', true,
  jsonb_build_object(
    'creditsEnabled', true,
    'expiry', jsonb_build_object('mode', 'course_end'),
    'selfExcuseDeadlineHours', 24,
    'redeemMatch', jsonb_build_object('ageMatchRequired', true, 'sameTagsRequired', false, 'crossCourse', true)
  ),
  :'owner_uid', :'owner_uid'
)
on conflict (id) do nothing;

-- Předškoláci 36–72 m — windows expiry (studio-entitled, doc 09 §3.2); no credits cap.
insert into public.courses
  (id, tenant_id, title, description, kind, status, capacity, age_min_months, age_max_months,
   registration_mode, show_on_public, excuse_policy, primary_coach_id, created_by)
values (
  :'course_prek', :'tenant_id', 'Plavání předškoláci', 'Plavání pro děti 3–6 let',
  'multi_session', 'active', 12, 36, 72, 'open', true,
  jsonb_build_object(
    'creditsEnabled', true,
    'expiry', jsonb_build_object('mode', 'windows', 'windowIds', jsonb_build_array(:'window_jaro'), 'forwardWindows', 1),
    'selfExcuseDeadlineHours', 48,
    'redeemMatch', jsonb_build_object('ageMatchRequired', true, 'sameTagsRequired', true, 'crossCourse', false)
  ),
  :'owner_uid', :'owner_uid'
)
on conflict (id) do nothing;

-- tags (used by redemption matching) + the owner as the assigned coach (so own-scope RLS resolves).
insert into public.course_tags (course_id, tag) values
  (:'course_baby',    'plavani'), (:'course_baby',    'baby'),
  (:'course_toddler', 'plavani'), (:'course_toddler', 'toddler'),
  (:'course_prek',    'plavani'), (:'course_prek',    'preschool')
on conflict do nothing;

insert into public.coach_assignments (course_id, user_id, is_primary) values
  (:'course_baby',    :'owner_uid', true),
  (:'course_toddler', :'owner_uid', true),
  (:'course_prek',    :'owner_uid', true)
on conflict do nothing;

-- ── sessions (one past + one upcoming for the baby course; the past one is what gets excused) ────────────────
insert into public.sessions (id, tenant_id, course_id, starts_at, duration_min, location, sequence, status) values
  (:'sess_baby_past', :'tenant_id', :'course_baby', timestamptz '2026-06-10 09:00:00+02', 30, 'Bazén A', 1, 'scheduled'),
  (:'sess_baby_next', :'tenant_id', :'course_baby', timestamptz '2026-06-17 09:00:00+02', 30, 'Bazén A', 2, 'scheduled')
on conflict (id) do nothing;

-- ── the child participant + the guardian link + an active enrollment ─────────────────────────────────────────
-- born 2025-09-01 → ~9 months at the 2026-06 sessions: inside the Kojenci 3–12 m band.
insert into public.participants (id, tenant_id, full_name, date_of_birth, note)
values (:'child_id', :'tenant_id', 'Eliška Rodičová', date '2025-09-01', 'Bojí se vody na obličeji.')
on conflict (id) do nothing;

insert into core.guardianships (user_id, participant_id, tenant_id, relation, is_primary)
values (:'guardian_uid', :'child_id', :'tenant_id', 'parent', true)
on conflict (user_id, participant_id) do nothing;

insert into public.enrollments (id, tenant_id, course_id, participant_id, source, status, payment_status)
values (:'enroll_id', :'tenant_id', :'course_baby', :'child_id', 'staff', 'active', 'paid')
on conflict (id) do nothing;

-- ── the signature flow: one EXCUSED attendance that issued an ACTIVE credit (doc 08 §1) ──────────────────────
-- 1) coach marked the child excused on the past session.
insert into public.attendance (tenant_id, session_id, participant_id, enrollment_id, state, marked_by)
values (:'tenant_id', :'sess_baby_past', :'child_id', :'enroll_id', 'excused', :'owner_uid')
on conflict (session_id, participant_id) do nothing;

-- 2) the excuse (source='staff') → about to be linked to a credit.
insert into public.excuses (id, tenant_id, session_id, participant_id, enrollment_id, source, status)
values (:'excuse_id', :'tenant_id', :'sess_baby_past', :'child_id', :'enroll_id', 'staff', 'credit_issued')
on conflict (session_id, participant_id) do nothing;

-- 3) the ACTIVE credit minted from it — tags + match rules + ttl expiry snapshotted from the Kojenci course
--    (creditsEnabled true, ttl 30d → say issued mid-June, valid into mid-July). The credit IS the omluvenka.
insert into public.credits
  (id, tenant_id, participant_id, source_excuse_id, source_course_id, source_session_id,
   tags, match_age, match_tags, match_cross_course, expires_at, status)
values (
  :'credit_id', :'tenant_id', :'child_id',
  :'excuse_id', :'course_baby', :'sess_baby_past',
  array['plavani','baby'], true, true, false,
  timestamptz '2026-07-10 09:00:00+02', 'active'
)
on conflict (id) do nothing;

-- link the excuse to the issued credit (closes the loop, doc 08 §4/§7).
update public.excuses
   set credit_id = :'credit_id'
 where id = :'excuse_id';

-- Result: in the portal, Petr Rodič sees "1 omluvenka" for Eliška, redeemable into sess_baby_next (free seat,
-- right age, matching 'plavani'/'baby' tag, same course) via redeem_credit_into_session.
