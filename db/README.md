<!-- ILLUSTRATIVE MOCKUP — realizes the migration recipe referenced by docs/03-data-model.md §7 (last line). -->

# Reference schema — Postgres + RLS

The concrete, **vendor-neutral** Postgres schema (the reference migration): the `core` framework schema (from `reservation-core`),
the `public` app domain (courses, sessions, the omluvenka economy), and plugin schemas (`sms`, shipped with the
plugin package). Authoritative names come from [docs/03-data-model.md](../docs/03-data-model.md);
the omluvenka logic from [docs/08-attendance-and-omluvenky.md](../docs/08-attendance-and-omluvenky.md); the RLS
two-gate model from [docs/04-roles-and-permissions.md](../docs/04-roles-and-permissions.md).

## Migration order

Apply in numeric order — each depends on the previous:

| # | File | Creates | Depends on |
|---|------|---------|------------|
| 1 | `migrations/0001_core.sql` | schema `core`; `tenants` · `profiles` · `memberships` (+ `one_owner_per_tenant`) · `participant_accounts` · `plugin_activations` · `plugin_settings` · `tenant_domains` · `audit_log` · `email_events` · `outbox` · `notifications` · `platform_admins`; the functions `role_rank()`, `is_member_of()` *(SECURITY DEFINER)*, `my_role()`, `can_act_for_participant()` *(SECURITY DEFINER)*, `set_updated_at()`, `create_tenant_with_owner()` *(SECURITY DEFINER)*; RLS on every table. | Postgres ≥ 14 (no vendor schema) |
| 2 | `migrations/0002_courses.sql` | schema `public` course/enrollment domain: `participants` · `courses` · `sessions` · `course_tags` · `coach_assignments` · `validity_windows` · `custom_field_definitions` · `course_field_assignments` · `applications` · `enrollments` · `participant_field_values`; the domain enums; `set_updated_at` triggers; RLS (staff via `is_member_of`, coach **own** via `coach_assignments`, family via `can_act_for_participant`, anon public catalogue). Wires the deferred `core.participant_accounts.participant_id` FK. | 0001 |
| 3 | `migrations/0003_omluvenky.sql` | `attendance` · `excuses` · `credits` · `makeups` · `credit_audit`; the omluvenka enums; the ★ **`public.redeem_credit_into_session(p_credit, p_session)`** SECURITY DEFINER RPC; the `credit.issued` outbox trigger; RLS. | 0002 |
| — | `seed.sql` | the "Plavecká škola Delfínek" demo (a `studio` tenant, an owner + a guardian + a child, 3 courses with month-based age bands + sessions, and one excused attendance that minted an active credit). | 0001–0003 |

> **Identities are external.** `core` references users by bare `uuid` — no FK to any vendor `auth.users` table.
> The caller is resolved by **`core.current_user_id()`**, the portable seam that reads `request.jwt.claims ->> 'sub'`
> (Supabase / PostgREST) **or** an `app.user_id` GUC a direct-driver adapter sets with `SET LOCAL` (doc 14 §3.1).
> An adapter may override the function (the Supabase adapter optionally aliases it to `auth.uid()`).

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
- **Family is relational.** `core.can_act_for_participant(participant_id)` (also `SECURITY DEFINER`) gates a guardian's
  reads of their participant's `participants`/`enrollments`/`attendance`/`credits`/`makeups` rows (doc 04 §7).
- **Anon catalogue.** Public reads are scoped `to anon using (show_on_public and status = 'active')` (doc 03 §7).
- **Memberships are self-row.** `memberships_self_read` exposes only `user_id = core.current_user_id()`; cross-member admin
  reads go through a `SECURITY DEFINER` RPC or the service-role client. Membership writes are **rank-capped**
  (`role < my_role(tenant)` and never `owner`) so even a misused service path can't mint a rogue owner (doc 04 §5).
- **Atomic capacity.** Booking a makeup never inserts directly — it goes through
  `redeem_credit_into_session`, which does `SELECT … FOR UPDATE` on the session's counted rows before inserting,
  preventing overbooking under concurrency (doc 08 §6 step 3).

## Running

Illustrative SQL — runs on any **Postgres ≥ 14** (Supabase, Neon, RDS, Fly, or a local one), no vendor CLI:

```bash
# apply migrations in order, then the seed — all plain psql
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f seed.sql          # seed.sql uses \set psql vars → run with psql
```

The RLS predicates read the caller via `core.current_user_id()` — set `request.jwt.claims` (Supabase / PostgREST
do this from the JWT) or `SET LOCAL app.user_id = '<uuid>'` per request. On Supabase, `supabase db push` /
`supabase db reset` also apply `migrations/`.

> The `redeem_credit_into_session` RPC and all `is_member_of`/`can_act_for_participant` predicates are
> `SECURITY DEFINER` with a pinned `search_path`; review them as privileged code (doc 04 §6 — privileged paths
> always re-check authorization, which the RPC does via `can_act_for_participant` before any write).
