<!-- ILLUSTRATIVE MOCKUP — realizes the migration recipe referenced by docs/03-data-model.md §7 (last line). -->

# Supabase schema — Termínář 2

The concrete Postgres/Supabase schema for Termínář 2: the `core` framework schema (from `reservation-core`),
the `public` app domain (courses, sessions, the omluvenka economy), and plugin schemas (`sms`, shipped with the
plugin package). Authoritative names come from [docs/03-data-model.md](../docs/03-data-model.md);
the omluvenka logic from [docs/08-attendance-and-omluvenky.md](../docs/08-attendance-and-omluvenky.md); the RLS
two-gate model from [docs/04-roles-and-permissions.md](../docs/04-roles-and-permissions.md).

## Migration order

Apply in numeric order — each depends on the previous:

| # | File | Creates | Depends on |
|---|------|---------|------------|
| 1 | `migrations/0001_core.sql` | schema `core`; `tenants` · `profiles` · `memberships` (+ `one_owner_per_tenant`) · `guardianships` · `plugin_activations` · `plugin_settings` · `tenant_domains` · `audit_log` · `email_events` · `outbox` · `notifications` · `platform_admins`; the functions `role_rank()`, `is_member_of()` *(SECURITY DEFINER)*, `my_role()`, `guardian_can_act()` *(SECURITY DEFINER)*, `set_updated_at()`, `create_tenant_with_owner()` *(SECURITY DEFINER)*; RLS on every table. | `auth.users` (Supabase) |
| 2 | `migrations/0002_courses.sql` | schema `public` course/enrollment domain: `participants` · `courses` · `sessions` · `course_tags` · `coach_assignments` · `validity_windows` · `custom_field_definitions` · `course_field_assignments` · `applications` · `enrollments` · `participant_field_values`; the domain enums; `set_updated_at` triggers; RLS (staff via `is_member_of`, coach **own** via `coach_assignments`, family via `guardian_can_act`, anon public catalogue). Wires the deferred `core.guardianships.participant_id` FK. | 0001 |
| 3 | `migrations/0003_omluvenky.sql` | `attendance` · `excuses` · `credits` · `makeups` · `credit_audit`; the omluvenka enums; the ★ **`public.redeem_credit_into_session(p_credit, p_session)`** SECURITY DEFINER RPC; the `credit.issued` outbox trigger; RLS. | 0002 |
| — | `seed.sql` | the "Plavecká škola Delfínek" demo (a `studio` tenant, an owner + a guardian + a child, 3 courses with month-based age bands + sessions, and one excused attendance that minted an active credit). | 0001–0003 |

The plugin's own schema is **not** here — `sms` ships with its package
([`plugins/sms/migrations/0001_sms.sql`](../plugins/sms/migrations/0001_sms.sql)) and is applied after these.
A plugin migration may reference `core.*`/`public.*` by id but may never alter them (doc 09 §1, §8).

## How RLS works here (the two-gate model)

Authorization is **belt-and-suspenders** (doc 01 §5, doc 04 §4): the app edge (`withRoute`) returns clean
errors, and **RLS is the invariant that holds even if a route is mis-wired**. Both gates read the *same*
definitions.

- **One membership predicate.** Every tenant-owned table's policy calls **`core.is_member_of(tenant_id [, min_role])`**
  — never an inline `select … from memberships` subquery. Because the function is **`SECURITY DEFINER`**, a
  policy on `core.memberships` that must read `core.memberships` does **not** recurse (the "infinite recursion in
  policy" bug Restaurio hit, doc 03 §7).
- **`own` vs `any` is the `USING` clause.** Admin/owner writes gate on `is_member_of(tenant_id, 'admin')`; a
  coach's **own**-scope write *additionally* requires a `coach_assignments` match (directly on `courses`, or
  through the session's course for `attendance`/`sessions`). Multiple `FOR` policies are **OR-ed** by Postgres,
  so `*_write_any` (admin) and `*_write_own` (coach) compose. See `courses_write_own`, `sessions_write_own`,
  `attendance_write_own` for the worked examples (doc 04 §4).
- **Family is relational.** `core.guardian_can_act(participant_id)` (also `SECURITY DEFINER`) gates a guardian's
  reads of their participant's `participants`/`enrollments`/`attendance`/`credits`/`makeups` rows (doc 04 §7).
- **Anon catalogue.** Public reads are scoped `to anon using (show_on_public and status = 'active')` (doc 03 §7).
- **Memberships are self-row.** `memberships_self_read` exposes only `user_id = auth.uid()`; cross-member admin
  reads go through a `SECURITY DEFINER` RPC or the service-role client. Membership writes are **rank-capped**
  (`role < my_role(tenant)` and never `owner`) so even a misused service path can't mint a rogue owner (doc 04 §5).
- **Atomic capacity.** Booking a makeup never inserts directly — it goes through
  `redeem_credit_into_session`, which does `SELECT … FOR UPDATE` on the session's counted rows before inserting,
  preventing overbooking under concurrency (doc 08 §6 step 3).

## Running

These are illustrative SQL files; against a real Supabase project:

```bash
# link once
supabase link --project-ref <ref>

# apply migrations in order (Supabase CLI runs migrations/ lexically), then seed
supabase db push
psql "$DATABASE_URL" -f supabase/seed.sql          # seed.sql uses \set psql vars → run with psql

# or, fully local
supabase start
supabase db reset                                   # re-applies migrations/ + seed.sql
```

> The `redeem_credit_into_session` RPC and all `is_member_of`/`guardian_can_act` predicates are
> `SECURITY DEFINER` with a pinned `search_path`; review them as privileged code (doc 04 §6 — privileged paths
> always re-check authorization, which the RPC does via `guardian_can_act` before any write).
