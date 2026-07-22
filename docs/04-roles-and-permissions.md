# 04 — Roles & permissions

> How **who you are** becomes **what you may do**, on both gates. The same definitions feed `withRoute`
> (the app edge, see [02 §4](02-reservation-core.md)) **and** Postgres RLS (the database invariant, see
> [03 §7](03-data-model.md)). Names here (`core.roles`, `core.memberships`, `core.participant_accounts`,
> `core.is_member_of()`, `core.is_owner()`, `core.is_admin()`, `core.can_act_for_participant()`) are
> authoritative and taken verbatim from [03](03-data-model.md).
>
> **The framework owns no role vocabulary.** It provides only the *mechanism* — a ranked ladder plus two
> capability flags (`is_owner`, `is_admin`) — and each app declares its own roles at boot with `defineRoles()`
> (TypeScript) mirrored by a `core.roles` seed (SQL). The `staff/coach/admin/owner` names below are
> **Terminar's example catalogue for one domain**, not a framework default; a different app brings its own (see
> the Výkazník `worker/reviewer/admin/owner` set in §2).

## 1. The actor model

There are **four kinds of actor**; they map directly to the personas table in [00 §4](00-overview.md) and to
the four access surfaces in [01 §7](01-architecture.md). Authorization always starts by deciding *which actor
class* a request belongs to — that is the `audience` of the route ([02 §2](02-reservation-core.md)).

| Actor class | CZ (UI) | Backed by | Identity row | Surface | `audience` |
|---|---|---|---|---|---|
| **Staff** | Personál | a **membership** in a tenant | `core.memberships(user_id, tenant_id, role)` | Admin console | `staff` |
| **Family** | Rodina | a **participant account** over participant(s) | `core.participant_accounts(user_id, participant_id, relation)` | Participant portal | `family` |
| **Anonymous applicant** | Zájemce | nothing (no session) | — (later a `safe_link_token` on `public.applications`) | Public/enrollment | `public` |
| **Platform operator** | Provozovatel | a **platform-admin** grant | `core.platform_admins(user_id)` (§6) | Ops back-office | `operator` |

Key facts that the rest of this doc builds on:

- A single `auth.users` row may be **both** staff and family (a coach whose own child attends the studio).
  `requireClaims()` returns `memberships[]` **and** `participantAccounts[]`; the route's `audience` picks which
  context is *required* and which RLS predicate family applies. See [02 §7](02-reservation-core.md) and
  [05 §4](05-auth.md).
- **Staff authorization is role-ranked and permission-scoped** (this document, §2–§4).
- **Family authorization is relational**, not role-ranked: a guardian may act *only* for the participants they
  are linked to, via `core.can_act_for_participant()` (§7).
- **Platform-operator authorization is cross-tenant** and lives *outside* tenant RLS (§6).

## 2. Role hierarchy

Staff roles are **app-defined data, not a framework enum.** The type is an open `AppRole = string`; the
framework only knows how to compare roles by **rank** and which one is the **owner**. Each app declares its
vocabulary once at boot with `defineRoles()` (mirroring `setPermissionGrants()` and `setTierEntitlements()`),
so a project's role names never leak into the framework. `defineRoles()` validates the set (unique keys, at
most one `isOwner`, owner defaults to the top rank) and backs `roleRank()` / `roleAtLeast()`.

Terminar declares the catalogue below — `employee < admin < owner` generalized (rename `employee → staff`,
insert `coach` for the course domain, see [02 §9](02-reservation-core.md)):

```ts
// apps/terminar/src/server/runtime.ts — the composition root, runs before any authz check
import { defineRoles } from '@deverjak/tenantkit-kernel'

defineRoles([
  { key: 'staff', rank: 1 },
  { key: 'coach', rank: 2 },
  { key: 'admin', rank: 3, isAdmin: true },
  { key: 'owner', rank: 4, isOwner: true, isAdmin: true },
])
```

> **A different app declares a different set — nothing else changes.** Výkazník (a field-ops product) uses
> `defineRoles([{ key: 'worker', rank: 10, label: 'Pracovník' }, { key: 'reviewer', rank: 20, label: 'Kontrolor' },
> { key: 'admin', rank: 30, label: 'Správce', isAdmin: true }, { key: 'owner', rank: 40, label: 'Vlastník', isAdmin: true, isOwner: true }])`.
> The ranks are arbitrary integers (only their *order* matters), and `label` is optional (apps usually localize
> labels in their own i18n instead).

The rest of this section describes **Terminar's** four roles concretely; read them as an illustration of the
mechanism, not a fixed framework vocabulary.

| Rank | Role key | CZ (UI) | One-line scope |
|---|---|---|---|
| 1 | `staff` | Recepce / Personál | Front-desk: process applications, manage participants, mark attendance — no course authorship, no settings. |
| 2 | `coach` | Lektor / Trenér | Owns the courses they are assigned to: sessions, attendance, credits **on own courses**. |
| 3 | `admin` | Správce | Full operational control over **any** course in the tenant; manages staff (below owner), settings, plugins. |
| 4 | `owner` | Majitel | Everything `admin` can, plus billing, owner transfer, tenant deletion. **Exactly one per tenant.** |

`roleAtLeast(role, min)` (rank comparison) is the coarse gate; the fine-grained catalogue in §3 is the precise
one. `withRoute({ minRole })` ANDs with `withRoute({ can })`.

> **The owner role is unique per tenant.** "Owner" is whichever role the app flags `isOwner` (Terminar's
> `owner`, Výkazník's `owner`, rank-40) — `core.roles.is_owner` records it, and a partial unique index
> (`roles_single_owner`) allows **at most one** owner role in the vocabulary. Per-tenant uniqueness is enforced
> by the `core.enforce_single_owner()` trigger on `core.memberships` (it reads `core.roles.is_owner` rather than
> a literal `role = 'owner'`, so it works for any vocabulary — see [03 §3](03-data-model.md)). Promoting a new
> owner is therefore a *transfer* (demote the incumbent in the same transaction), never a second insert — see §8.

### What each role can do (capability matrix)

Read top-to-bottom as "minimum role for the common case"; `own` means *only rows the actor is assigned to*,
`any` means *any row in the tenant* (the §3 scope distinction). `—` = denied.

| Area (CZ) | `staff` | `coach` | `admin` | `owner` |
|---|---|---|---|---|
| Courses — kurzy (view) | any | any | any | any |
| Courses — kurzy (create/edit/delete) | — | own | any | any |
| Assign coach to course | — | — | any | any |
| Sessions — lekce (manage, recurrence) | — | own | any | any |
| Attendance — docházka (record) | any | own | any | any |
| Applications — přihlášky (view/decide) | any | own | any | any |
| Participants — účastníci (view/manage) | any | own | any | any |
| Enrollments — zápisy (manage) | any | own | any | any |
| Credits — omluvenky (manage / redeem-for-family) | — | own | any | any |
| Credits — grant ad-hoc / extend expiry | — | — | any | any |
| Settings — nastavení (view) | view | view | manage | manage |
| Staff — personál (view / manage memberships) | — | view | manage¹ | manage |
| Plugins — moduly (enable/configure) | — | — | manage | manage |
| Billing — předplatné (Stripe, tier) | — | — | — | manage |
| Reports — přehledy (view) | own | own | any | any |

¹ `admin` may manage memberships **below their own rank** (add/edit `staff`, `coach`; not `admin`/`owner`);
only `owner` manages `admin`s and performs owner transfer (§8). This "can't escalate past yourself" rule is
enforced in the staff-management use-case **and** by RLS (§5).

### Capability flags — `is_owner` / `is_admin`

Two boolean flags on each role decouple the **framework's** authorization from your role *names*, so core
policies never hardcode a vocabulary:

- **`is_owner`** — the single top principal every tenant has exactly one of. Used for provisioning
  (`create_tenant_with_owner` resolves the owner role via `where is_owner`), the one-owner invariant, and the
  staff invite rank-cap. At most one role in the vocabulary may set it.
- **`is_admin`** — "may administer the tenant". A declarative capability, independent of rank: an app *could*
  flag more than one role `is_admin`, and it is not implied by a high rank.

Framework-CORE RLS (the `0001_core` migration) references **only** the capability predicates
`core.is_owner(tenant)` and `core.is_admin(tenant)` — never a literal role name — so those policies work
unchanged for any app's vocabulary. (App-owned *domain* policies may still name their own roles, e.g.
`core.is_member_of(tenant_id, 'coach')`; those keys are the app's, not the framework's — see §4.)

### The TS ↔ SQL bridge (`defineRoles` ⇄ `core.roles`)

Ranks and flags live in **two** places that must agree: `defineRoles()` (evaluated by `withRoute`) and the
`core.roles` table (read by RLS via `core.role_rank()` / `core.is_owner()` / `core.is_admin()`). The kernel
keeps them in lock-step:

- **Seed** `core.roles` from the *same* `RoleDef[]` you pass to `defineRoles()`, with
  `rolesSeedSql(roles)` — an idempotent `insert … on conflict do update` (it derives the owner the same way
  `defineRoles` does). It **never deletes** a role, because live memberships may reference it; removing a role
  or changing which one is owner stays an explicit, transactional migration.
- **Verify** there's no drift with `diffRoleSeed(getRoles(), rows)`, where `rows` come from a plain
  `select key, rank, is_owner, is_admin from core.roles`. It is **pure and read-only** — safe to run at startup
  or in CI without ever mutating the database — and returns a ready-to-log `report` of any missing/extra roles
  or rank/flag mismatches (labels are ignored, being an i18n concern). `core.role_rank(key)` is just a lookup
  into this seeded table, so app- and DB-gates share one set of ranks.

## 3. The permission catalogue (an app-owned example: Terminar's course domain)

Coarse roles are not enough — the brief (and legacy) call for **fine-grained `resource:action:scope`
permissions**. `scope ∈ { own, any }` is what later becomes an RLS `USING` clause (§5). The catalogue below is
**the app's** (Terminar's course domain); a different app declares its own. The framework only knows how to
*evaluate* `can(role, perm)` — the grant map is data the app wires once at boot with
`setPermissionGrants(TERMINAR_PERMISSIONS)` ([02 §15](02-reservation-core.md)), exactly like `defineRoles()`.
The type comes from core:

> **Rank does not imply grant inheritance.** The two staff gates are independent: `roleAtLeast()` is a coarse
> rank ladder, but a higher rank does **not** automatically receive a lower role's permission grants. Every
> role's grants are listed **explicitly** in the map (an `admin` row that omits `courses:create` simply lacks
> it, no matter that `admin` outranks `coach`). "Inheritance" you see in the tables below is just the app
> choosing to grant a superset — it is authored, not derived.

```ts
// @reservation-core/domain/rbac
type Scope = 'own' | 'any'
type Permission =
  | `${string}:${string}`            // scope-less (e.g. 'billing:manage')
  | `${string}:${string}:${Scope}`   // scoped     (e.g. 'courses:edit:any')
can(role: AppRole, perm: Permission, ctx?: { ownerOf?: boolean }): boolean
```

`ownerOf` is the runtime fact "the caller is assigned to *this* course" (a row in
`public.coach_assignments`), which lets a single permission resolve `own` vs `any` per-row at the app edge;
RLS independently enforces the same scoping in SQL.

### Catalogue (the `public.*` course domain)

| Permission | Meaning | Scopes |
|---|---|---|
| `courses:view` | See course rows | `own` \| `any` |
| `courses:create` | Author a new course | `any` |
| `courses:edit` | Edit a course's fields & policy | `own` \| `any` |
| `courses:delete` | Soft-delete a course | `own` \| `any` |
| `courses:assign-coach` | Add/remove `public.coach_assignments` | `any` |
| `sessions:manage` | Create/edit/cancel `public.sessions`, run the recurrence generator | `own` \| `any` |
| `attendance:record` | Write `public.attendance` (present/excused/absent) | `own` \| `any` |
| `applications:view` | Read `public.applications` | `own` \| `any` |
| `applications:decide` | Approve/reject → enroll | `own` \| `any` |
| `participants:view` | Read `public.participants` | `own` \| `any` |
| `participants:manage` | Edit participant record, notes, custom fields | `own` \| `any` |
| `enrollments:manage` | Enroll/cancel/move (`public.enrollments`) | `own` \| `any` |
| `credits:manage` | Cancel/retag/redeem `public.credits` on behalf of family | `own` \| `any` |
| `credits:grant` | Mint an ad-hoc credit, override/extend `expires_at` | `any` |
| `settings:view` | Read tenant settings | `any` |
| `settings:manage` | Edit tenant settings, validity windows, custom-field defs | `any` |
| `staff:view` | List memberships | `any` |
| `staff:manage` | Invite/edit/remove memberships (rank-capped, §2) | `any` |
| `plugins:manage` | Enable/disable & configure plugins | `any` |
| `billing:manage` | Stripe subscription, tier, owner-level money ops | `any` |
| `reports:view` | Attendance/credit rollups & exports | `own` \| `any` |

> `own` here means "scoped to courses the caller coaches" — concretely `exists(select 1 from
> public.coach_assignments ca where ca.course_id = <row>.course_id and ca.user_id = auth.uid())`. For
> participant/credit rows that have no direct `course_id`, `own` resolves through the participant's *active
> enrollment* into a coached course.

### Default role → permission grant map

The map the app ships (`TERMINAR_PERMISSIONS`, passed to `setPermissionGrants()` at boot). Cells: `own`,
`any`, or `—` (not granted) — **each role's row is authored in full** (§3, "rank does not imply inheritance").
A role with `any` implicitly satisfies an `own` requirement.

| Permission | `staff` | `coach` | `admin` | `owner` |
|---|---|---|---|---|
| `courses:view` | any | any | any | any |
| `courses:create` | — | any | any | any |
| `courses:edit` | — | own | any | any |
| `courses:delete` | — | own | any | any |
| `courses:assign-coach` | — | — | any | any |
| `sessions:manage` | — | own | any | any |
| `attendance:record` | any | own | any | any |
| `applications:view` | any | own | any | any |
| `applications:decide` | any | own | any | any |
| `participants:view` | any | own | any | any |
| `participants:manage` | any | own | any | any |
| `enrollments:manage` | any | own | any | any |
| `credits:manage` | — | own | any | any |
| `credits:grant` | — | — | any | any |
| `settings:view` | any | any | any | any |
| `settings:manage` | — | — | any | any |
| `staff:view` | — | any | any | any |
| `staff:manage` | — | — | any² | any |
| `plugins:manage` | — | — | any | any |
| `billing:manage` | — | — | — | any |
| `reports:view` | own | own | any | any |

² Rank-capped: `admin` may target only `staff`/`coach` rows (§2 note ¹).

The map is **data**, not code: a tenant on a future "custom roles" entitlement could override grants without
touching the framework. Core only knows how to *evaluate* `can(role, perm)`; the app owns the table.

## 4. Two consumers, one definition

The same `Permission` value is asserted at both gates. Authorization is **belt-and-suspenders by design**
([01 §5](01-architecture.md)): `withRoute` is the readable app gate that returns clean errors; RLS is the
invariant that holds even if a route is mis-wired or `getAdminClient()` is misused.

```
                    TERMINAR_PERMISSIONS  (role → {perm: scope})   ← single source of truth
                          │                                  │
            ┌─────────────┘                                  └──────────────┐
            ▼  app edge                                        DB invariant ▼
   withRoute({ minRole, can })                          RLS policy USING / WITH CHECK
   ctx.can('courses:edit:any')  ───── 403 FORBIDDEN     core.is_member_of(tenant_id,'coach')
                                                          + coach-assignment EXISTS for 'own'
```

### `withRoute` side

```ts
// apps/terminar/app/api/courses/[id]/route.ts  — edit a course
export const PATCH = withRoute(
  { audience: 'staff', tenantFrom: 'cookie',
    minRole: 'coach', can: 'courses:edit:own',     // coarse rank AND fine permission
    body: UpdateCourseSchema },
  async (ctx, _req, { params }) => {
    // ctx.can('courses:edit:any') lets the use-case skip the own-check for admins/owners
    const course = await updateCourse(ctx, { courseId: params.id, patch: ctx.input.body! })
    return jsonOk({ course })
  },
)
```

`withRoute` resolves `ctx.role` for the tenant, evaluates `can('courses:edit:own', { ownerOf })` by looking up
the caller's `coach_assignments`, and early-returns `403 FORBIDDEN` before the handler runs ([02 §4](02-reservation-core.md), pipeline step 5).

### RLS side — `own` vs `any` becomes a `USING` clause

The scope distinction is not just an app convenience; it is the policy. `any`-scoped writes gate on
`core.is_member_of(tenant_id, '<min_role>')`; `own`-scoped writes additionally require a coach-assignment
match. Consistent with the predicate families in [03 §7](03-data-model.md):

```sql
-- public.courses : admins/owners edit ANY course in the tenant; coaches edit only assigned ones.
-- READ — any member of the tenant:
create policy courses_read on public.courses
  for select using (core.is_member_of(tenant_id));

-- WRITE (admin+) — 'any' scope: rank >= admin is sufficient:
create policy courses_write_any on public.courses
  for all
  using      (core.is_member_of(tenant_id, 'admin'))
  with check (core.is_member_of(tenant_id, 'admin'));

-- WRITE (coach) — 'own' scope: must be a member at coach rank AND assigned to THIS course:
create policy courses_write_own on public.courses
  for update
  using (
    core.is_member_of(tenant_id, 'coach')
    and exists (
      select 1 from public.coach_assignments ca
      where ca.course_id = courses.id
        and ca.user_id   = auth.uid()
    )
  )
  with check (
    core.is_member_of(tenant_id, 'coach')
    and exists (
      select 1 from public.coach_assignments ca
      where ca.course_id = courses.id
        and ca.user_id   = auth.uid()
    )
  );
```

A second example — `public.attendance`, where `own` resolves through the **session's course**:

```sql
-- attendance:record — coach may write only for sessions of a course they are assigned to:
create policy attendance_write_own on public.attendance
  for all
  using (
    core.is_member_of(tenant_id, 'coach')
    and exists (
      select 1
      from public.sessions s
      join public.coach_assignments ca on ca.course_id = s.course_id
      where s.id = attendance.session_id
        and ca.user_id = auth.uid()
    )
  )
  with check ( /* same predicate */ true );  -- mirrored; elided for brevity
```

> Because `core.is_member_of()` is `SECURITY DEFINER` it reads `core.memberships` without recursing
> ([03 §7](03-data-model.md) — the bug Restaurio hit). Multiple `FOR …` policies on one table are **OR-ed** by
> Postgres, so `courses_write_any` (admin) and `courses_write_own` (coach) compose: an `owner` passes via the
> first, a `coach` only via the second.

PostgreSQL `42501` (RLS denial) surfaces as `403` through the error map ([02 §5](02-reservation-core.md)),
matching the app-edge `403 FORBIDDEN` — the client toast layer cannot tell which gate refused, which is the
point.

## 5. Rank-capped staff management in SQL

The "can't escalate past yourself" rule (§2) is enforced in the database, not only the use-case, so a
misused service-role path still cannot create a rogue owner:

```sql
-- An actor may INSERT/UPDATE a membership only for a role strictly below their own rank, and never the owner
-- role (owner transfer goes through a SECURITY DEFINER RPC, §8). "owner" is the capability flag, not a literal
-- name, so this works for any app's vocabulary.
create policy memberships_manage on core.memberships
  for all
  using      (core.is_member_of(tenant_id, 'admin'))
  with check (
    core.is_member_of(tenant_id, 'admin')
    and not exists (select 1 from core.roles r where r.key = role and r.is_owner)
    and core.role_rank(role) < core.role_rank(core.my_role(tenant_id))
  );
-- self-row reads stay open so a user can always see their own membership:
create policy memberships_self_read on core.memberships
  for select using (user_id = auth.uid());
```

`core.my_role(tenant)` is the `SECURITY DEFINER` companion to `is_member_of` returning the caller's own
role key in the tenant (added to `@reservation-core/db` alongside `role_rank`). Cross-member admin *reads*
(the staff list) go through a `SECURITY DEFINER` RPC or the service-role client that re-checks authorization in
code — the same rule as [03 §7](03-data-model.md).

## 6. Platform operator (cross-tenant)

The platform operator (persona "Provozovatel", [00 §4](00-overview.md)) onboards tenants and runs support; by
definition they act **across** tenants, which tenant-scoped RLS is built to forbid. They are modeled as a
**separate grant table**, deliberately *not* a high-ranked role (there is no "super-owner" — that would pollute
every tenant policy):

```sql
create table core.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  level      platform_role not null default 'support',   -- support | superadmin
  created_at timestamptz not null default now()
);
-- the predicate, SECURITY DEFINER, used ONLY by ops routes/policies — never mixed into tenant policies:
create function core.is_platform_admin(p_min text default 'support')
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from core.platform_admins pa
    where pa.user_id = auth.uid()
      and core.platform_rank(pa.level) >= core.platform_rank(p_min))
$$;
```

How it is fenced off:

- **No tenant policy references `core.platform_admins`.** Operators do not gain access to tenant rows through
  RLS; tenant tables remain `is_member_of`-only. This keeps tenant isolation a clean invariant
  ([00 §8](00-overview.md)) and means a compromised support account cannot silently read a studio's data
  through the normal app.
- The **ops back-office** is the only surface that uses it. Those routes declare `audience: 'operator'`, which
  `withRoute` resolves with `core.is_platform_admin()` instead of `assertMember()`, and they run via
  `getAdminClient()` (service role, RLS-bypassing) — permitted there by the lint directory rule
  ([01 §4](01-architecture.md)) and **always re-checking** `is_platform_admin` in code.
- Cross-tenant ops tables (provisioning, support notes, tenant search) live in dedicated ops policies gated on
  `core.is_platform_admin('superadmin')` for destructive actions.
- Every operator action is `audit_log`-ged with a `null` `tenant_id` or the impersonated tenant id (§8), and
  operators require **2FA** ([05 §6](05-auth.md), [00 §4](00-overview.md)).

## 7. Family authorization

Family actors are not role-ranked; they are authorized **relationally**. The single predicate is
`core.can_act_for_participant(participant_id)` from [03 §7](03-data-model.md):

```sql
create function core.can_act_for_participant(p_participant uuid)
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from core.participant_accounts g
    where g.participant_id = p_participant
      and g.user_id        = auth.uid())
$$;
```

- A guardian sees and acts on a participant's rows (`public.participants`, `enrollments`, `attendance`,
  `credits`, `makeups`) **iff** a `core.participant_accounts` row links them — regardless of `relation`
  (`parent | guardian | self`). `relation = 'self'` is just an adult guardian over their own participant row
  ([03 §3](03-data-model.md)); it grants no extra power, only models the link.
- `withRoute({ audience: 'family' })` populates `ctx.participant` (a `ParticipantContext` of actable participant
  ids, [02 §4](02-reservation-core.md)) and the same SQL predicate is the RLS `USING` clause — the two-gate
  pattern again. Family routes never take a `minRole`/`can`; scope **is** the participant account.
- **No write crosses tenants or participants.** Even though `core.participant_accounts.tenant_id` is denormalized for
  speed, the authority is the `(user_id, participant_id)` pair, so a guardian of child A can never touch
  child B's data.
- Establishing the link (application approval → guardian match/invite; an adult self-managing with
  `relation='self'`; a guardian adding a second child) is an **authentication/onboarding** concern — see
  [05 §3](05-auth.md).

## 8. Decision flow, auditing & ADR

### Permission check decision flow

The order each authenticated request resolves (the `withRoute` pipeline of [02 §4](02-reservation-core.md),
read as a decision tree):

```
request → resolve audience (route declares it; default 'staff')
  ├─ public    → no identity; RLS anon policies only (catalogue, slot availability)
  ├─ operator  → core.is_platform_admin(min)?            no → 403 FORBIDDEN
  │              yes → ops route (service role, re-checks in code)
  ├─ family    → requireClaims(); participantAccounts non-empty?   no → 403 NOT_A_PARTICIPANT
  │              → ctx.participant = actable participant ids
  │              → RLS core.can_act_for_participant() gates every row
  └─ staff     → requireClaims()                              none → 401 UNAUTHORIZED
                 → resolve tenantId (param ‖ host ‖ active_tenant_id cookie)
                 → assertMember(tenant)?                       no → 403 NOT_A_MEMBER
                 → resolve role; roleAtLeast(role, minRole)?   no → 403 FORBIDDEN
                 → can(role, perm, { ownerOf })?               no → 403 FORBIDDEN
                 → (plugin/entitlement/rateLimit/validation…)  → handler
                                                                   │
                                            every write re-checked by RLS (42501 → 403)
```

### Auditing role changes

Security-relevant authorization changes are append-only `core.audit_log` rows ([01 §9](01-architecture.md),
[03 §3](03-data-model.md)). Specifically logged:

| Action | `entity` | `before` → `after` (jsonb) | Notes |
|---|---|---|---|
| Membership granted | `membership` | `null` → `{role}` | who invited, target user, tenant. |
| Role changed | `membership` | `{role:old}` → `{role:new}` | rank-cap enforced (§5); demotions included. |
| Membership revoked | `membership` | `{role}` → `null` | |
| **Owner transfer** | `membership` | `{owner:A, admin:B}` → `{owner:B, admin:A}` | atomic in one `SECURITY DEFINER` RPC `transfer_ownership(tenant, new_owner)`; demotes incumbent so the `core.enforce_single_owner()` trigger never trips (§2). |
| Plugin toggled | `plugin` | `{enabled:bool}` | also in scope of `plugins:manage`. |
| Operator action | `platform` | varies | `actor_user_id` = operator; `tenant_id` = target or `null` (§6). |

Each row carries `tenant_id`, `actor_user_id`, `action`, `entity`, `entity_id`, `at`. Audit writes happen in
the same transaction as the change (trigger or use-case), so a successful role change **always** has its trail.
The rationale for promoting `resource:action:scope` from legacy and for the two-gate model is in
[`adr/0002-extract-reservation-core.md`](adr/0002-extract-reservation-core.md).

Continue to **[05 — Auth](05-auth.md)** for how an actor *proves* its identity in the first place.
