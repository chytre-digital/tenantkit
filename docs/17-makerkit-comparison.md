# 17 — TenantKit vs. Makerkit (Next.js + Supabase Turbo)

> A side‑by‑side of the two schema architectures, with the focus the question asked for: **user → tenant
> resolution** and the **RLS / membership** model. Makerkit details are from its public docs
> ([database‑architecture], [permissions‑and‑roles], [RLS best practices]) as of 2026‑06; TenantKit details are
> authoritative from [03 — data model](03-data-model.md), [04 — roles & permissions](04-roles-and-permissions.md),
> and [`db/migrations/0001_core.sql`](../db/migrations/0001_core.sql).

## 0. TL;DR

Both kits land on the **same core security stance**: tenant isolation is a **Postgres RLS invariant**, the
membership check is centralized in a **`SECURITY DEFINER` function** (so a policy on the membership table doesn't
recurse), and role rank is a numeric ladder. Where they genuinely diverge:

| Axis | **TenantKit** | **Makerkit (next‑supabase‑turbo)** |
|---|---|---|
| Tenant noun | `core.tenants` — **only** organizations. No "personal" tenant. | `public.accounts` — **one table** for *both* personal accounts and team accounts (`is_personal_account`). |
| Personal workspace | None. A user with no membership goes to onboarding/provisioning. | Every user gets a personal account (id **=** `auth.users.id`) the moment they sign up (DB trigger). |
| Schema namespace | `core.*` (framework) + `public.*` (app domain) + plugin schemas. | Everything in `public.*`. |
| Auth coupling | **Decoupled** — `core.profiles.id` is FK‑less; identity resolved via `core.current_user_id()` (JWT GUC *or* `app.user_id`). Portable to Neon/RDS/laptop. | **Supabase‑native** — keyed to `auth.users`, predicates call `auth.uid()`. |
| Second actor class | **First‑class** family / participant accounts (`core.participant_accounts`, relational auth). | None — only account members. (Customer‑facing data is just account‑owned rows.) |
| Roles | Fixed enum `app_role` (staff<coach<admin<owner) + a data‑driven `resource:action:scope` permission map in **app code**. | `public.roles` + `public.role_permissions` + `app_permissions` enum — roles & grants live **in the database**, editable per app. |
| Permission granularity | `scope ∈ {own, any}` baked into both `withRoute` and RLS. | `has_permission(user, account, permission)` flag checks; no built‑in `own/any` row‑scope. |
| App‑edge gate | `withSlugRoute({ audience, minRole, can })` (slug‑in‑path, recommended) + legacy `withRoute` (cookie/host chain) — typed route wrappers, vendor‑free. | Server components / actions + `requireUser` + permission helpers, Supabase‑coupled. |
| Billing | A **plugin** (`payments.*` schema, entitlement‑gated). | **Core** (`subscriptions`, `orders`, `billing_customers` in `public`). |

The one‑sentence summary: **Makerkit is a Supabase‑native, account‑centric SaaS starter where "personal" and
"team" are the same row; TenantKit is a portable, ports‑and‑adapters multi‑tenant *backbone* with a stricter
org‑only tenant, a second relational actor class (family), and `own/any` row‑scoping pushed all the way into
RLS.**

## 1. The tenant/account model — the biggest structural difference

### Makerkit: one `accounts` table for everything

```
public.accounts(
  id uuid pk,                         -- personal: == auth.users.id;  team: gen_random_uuid()
  primary_owner_user_id uuid,         -- creator/owner
  is_personal_account boolean,        -- THE discriminator
  name text, slug text unique,        -- slug NULL for personal, required for team
  email text, picture_url text,
  public_data jsonb, ...
)
public.accounts_memberships(
  user_id uuid, account_id uuid,      -- composite PK
  account_role text references roles(name),
  created_at, ...
)
```

The defining idea: **a personal account and a team account are the same shape**. A signup trigger creates a
personal account whose `id` equals the `auth.users.id`; teams are extra `accounts` rows with members. *All*
business data hangs off `account_id`, so the same table and the same RLS work whether the owner is one person or
an org. "Switching workspace" = choosing which `account_id` you operate under.

### TenantKit: tenants are organizations only

```
core.tenants(id, slug unique, name, status, default_locale, tier, branding jsonb, settings jsonb, ...)
core.memberships(id, user_id, tenant_id, role app_role, unique(user_id, tenant_id))
core.profiles(id pk, full_name, locale, phone, avatar_url)   -- 1:1 with the IdP user, FK-less
```

There is **no personal tenant**. A `core.profiles` row is the per‑user record, but it is *not* a tenant — a user
with zero memberships isn't "in" anything; they hit onboarding/`provisionTenant`. This is a deliberate narrowing
([README](../README.md): "reservation‑style SaaS"): the product always has studios/organizations, never a
single‑user workspace, so the account‑unification Makerkit needs would be dead weight and would blur the
isolation boundary.

**Trade‑off.** Makerkit's unified model is brilliant for "Notion‑style" apps where a solo user is a valid
end‑state and may later upgrade to a team — no migration, the personal account just gains members. TenantKit
pays a little (no free personal space) to keep `tenant = organization` an unambiguous invariant, which makes the
second actor class (below) and the `own/any` scoping cleaner.

## 2. User → tenant resolution

This is where the kits feel most different in day‑to‑day use.

### Makerkit — slug in the URL path

The account context is carried in the **route**: `/home` is the personal workspace, `/home/[account]` is a team
workspace where `[account]` is the team's `slug`. A server‑side load resolves the slug → account, confirms the
user is a member (via a `user_account_workspace` view / `team_account_workspace` helper), and everything inside
renders for that `account_id`. Resolution is **explicit and URL‑addressable**; there's no ambient "active
account" cookie — the path *is* the selector.

### TenantKit — both models: slug‑in‑path (`withSlugRoute`, recommended) or the legacy chain

**Since kernel 0.5.0 TenantKit ships the Makerkit‑style selector natively.** `withSlugRoute`
([02 §4a](02-reservation-core.md)) resolves the tenant from a `[slug]` route param via the
`AuthzStore.getTenantBySlug` port — for **every** audience, `public` included — asserts membership
(`401 → 404 → 403`), and never touches a cookie; `resolveTenantWorkspace` is the page‑layer companion
(Makerkit's `loadTeamWorkspace` analog). Termínář runs on this (`/projects/[slug]/…`). Two deltas vs.
Makerkit's loader: the tenant is resolved even for anonymous/public slug routes, and the family
(participant‑account) audience is scoped to the resolved tenant.

The **legacy** staff resolution is the fallback ladder (see
[`tenancy/index.ts`](../packages/kernel/src/tenancy/index.ts), [04 §8](04-roles-and-permissions.md)):

```
explicit param  →  host (subdomain ‹slug›.terminar.cz / custom domain via core.tenant_domains)  →  active_tenant_id cookie
```

- `withRoute({ tenantFrom: 'param' | 'host' | 'cookie' | fn })` declares the source per route.
- `resolveActiveTenant()` trusts the `active_tenant_id` cookie **only if** it matches a real membership, else
  falls back to the first membership (a stale cookie silently degrades rather than 403s).
- `assertMember()` is the app‑edge gate; **`core.is_member_of()` in RLS is the second gate** — belt and
  suspenders.
- Switching tenants is `POST /api/auth/switch-tenant`, which validates membership then sets the httpOnly cookie.

So Makerkit has one **stateless, URL‑addressable** selector (slug in path); TenantKit **defaults new apps to the
same model** (`withSlugRoute`) and keeps the **multi‑source chain ending in a validated cookie** as the legacy
path (`withRoute`, deprecated‑but‑supported) — because TenantKit also targets **subdomain and custom‑domain**
tenancy (`core.tenant_domains`), where the host *is* the tenant and there's no slug in the path to read.

### The decoupled identity seam (TenantKit‑only)

TenantKit's predicates never call `auth.uid()` directly. They call:

```sql
create function core.current_user_id() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub',  -- Supabase / PostgREST
    nullif(current_setting('app.user_id', true), '')                          -- direct-driver: SET LOCAL
  )::uuid
$$;
```

This is the portability seam ([ADR‑0009](adr/0009-portability-ports-and-adapters.md)): the *identical* RLS runs
on Supabase, Neon, RDS, or a plain Postgres where a direct driver does `SET LOCAL app.user_id`. The Supabase
adapter *may* override it to `select auth.uid()`. **Makerkit has no such seam** — it is Supabase‑native by design
and calls `auth.uid()` throughout. This is the single clearest philosophical split: TenantKit is "Postgres + RLS
is the only hard dependency, the vendor is swappable"; Makerkit is "Supabase is the platform."

## 3. The membership predicate & RLS — convergent, with a twist

Both centralize the membership check in a `SECURITY DEFINER` function to dodge the *"infinite recursion in
policy"* bug (a policy on the membership table querying the membership table). This is essentially the **same
lesson learned independently** — TenantKit even has [ADR‑0008](adr/0008-rls-is-member-of.md) about it.

**Makerkit:**
```sql
-- bypasses RLS on the lookup tables during the check
public.has_role_on_account(account_id uuid, account_role varchar default null) returns boolean  -- SECURITY DEFINER
public.has_permission(user_id uuid, account_id uuid, permission app_permissions) returns boolean -- SECURITY DEFINER
public.is_account_owner(account_id uuid) returns boolean
-- policies: using (public.has_role_on_account(account_id))
```

**TenantKit:**
```sql
core.is_member_of(p_tenant uuid, p_min_role text default 'staff') returns boolean   -- SECURITY DEFINER STABLE
core.my_role(p_tenant uuid) returns text                                            -- SECURITY DEFINER
core.can_act_for_participant(p_participant uuid) returns boolean                     -- SECURITY DEFINER (family)
core.is_platform_admin(p_min text) returns boolean                                  -- cross-tenant ops
-- policies: using (core.is_member_of(tenant_id))  /  with check (core.is_member_of(tenant_id, 'admin'))
```

Same shape. Two TenantKit specifics worth calling out:

1. **`own` vs `any` is encoded in RLS, not just app code.** A coach editing "their" course passes a *second*
   predicate (`exists(... coach_assignments ...)`) on top of `is_member_of(tenant_id, 'coach')`; admins/owners
   pass the `any` policy. Postgres OR‑s the two `FOR …` policies. Makerkit's `has_permission` is a boolean
   feature flag ("can manage members"), not a per‑row `own/any` distinction — row scoping, if needed, is
   hand‑written per table.
2. **A second predicate family for the family actor.** `core.can_act_for_participant()` authorizes guardians
   *relationally* (you may touch a participant's rows iff a `participant_accounts` link exists), entirely
   separate from role rank. Makerkit has no equivalent because it has no end‑customer actor in the schema.

### Where they *disagree* on philosophy: JWT claims

TenantKit [ADR‑0008](adr/0008-rls-is-member-of.md) explicitly **rejected** carrying memberships/roles in JWT
custom claims (staleness on role change, token bloat with many tenants, authz moving into token issuance) and
keeps the membership table the single source of truth, read per query through the `SECURITY DEFINER` helper.
Makerkit reads from `accounts_memberships`/`role_permissions` at query time too, but its broader stack leans more
on Supabase JWT/session machinery. If you value "a demotion takes effect on the next query, always," TenantKit's
no‑claims stance is the stricter guarantee.

## 4. Roles & permissions

| | TenantKit | Makerkit |
|---|---|---|
| Where roles live | `app_role` **enum** in SQL; rank in `core.role_rank()`. | `public.roles(name, hierarchy_level)` **table**. |
| Where grants live | `TERMINAR_PERMISSIONS` map in **app code** (`role → {perm: scope}`); type `resource:action:scope`. | `public.role_permissions(role, permission)` **table**; `app_permissions` **enum**. |
| Hierarchy | owner 4 > admin 3 > coach 2 > staff 1; `roleAtLeast`. | numeric `hierarchy_level`, lower = more powerful (owner = 1). |
| Per‑row scope | `own` vs `any` first‑class, in RLS + edge. | feature‑flag permissions; no built‑in row scope. |
| Custom roles | Possible via the data map (a future entitlement) but enum is fixed. | Native — add rows to `roles`/`role_permissions` per app. |
| "Can't escalate past yourself" | Enforced in **SQL** (`role <> 'owner' and role_rank(role) < role_rank(my_role(tenant))`) *and* the use‑case. | Enforced via `hierarchy_level` checks in functions/policies. |
| Exactly one owner | Partial unique index `one_owner_per_tenant ... where role='owner'`; promotion = atomic transfer RPC. | `primary_owner_user_id` column on the account is the single owner. |

Net: **Makerkit makes roles/permissions data** (editable in the DB, more flexible for arbitrary SaaS), while
**TenantKit makes role rank a fixed enum but pushes the *permission grant map* to app config** and adds a real
`own/any` row dimension that Makerkit leaves to the developer. TenantKit's owner‑uniqueness is a DB invariant
(partial index); Makerkit's is a column.

## 5. Second actor class — TenantKit's distinctive piece

TenantKit models **four** actor classes ([04 §1](04-roles-and-permissions.md)): staff (membership), **family**
(participant account), anonymous applicant (no session), and platform operator (`core.platform_admins`, a
*separate* grant table deliberately kept out of every tenant policy so there's no "super‑owner" leaking into
tenant RLS). The family side (`core.participant_accounts` + `public.participants`) is the identity the legacy
products lacked, and it gets its own relational RLS predicate.

Makerkit has **two**: account members and (implicitly) the public/anon role. There's no built‑in "this end
customer may act on these specific rows across the tenant boundary" concept — that's app‑specific work.

This reflects the domains: Makerkit is a generic B2B SaaS starter (your users *are* the account members);
TenantKit is reservation SaaS where the studio's *customers* (parents/participants) need scoped self‑service
without being staff.

## 6. Namespacing, billing, plugins

- **Schemas.** TenantKit segregates: `core.*` (framework), `public.*` (app domain), `payments.*`/`sms.*`
  (plugin‑owned). Plugins reference core/app rows by id but never alter them ([03 §9](03-data-model.md)).
  Makerkit keeps essentially everything in `public.*`.
- **Billing.** First‑class in Makerkit core (`subscriptions`, `subscription_items`, `orders`,
  `billing_customers`). In TenantKit it's a **plugin** behind an entitlement; only a materialized
  `core.tenants.tier` and `enrollments.payment_status` live in core, kept fresh by the payments plugin
  ([ADR‑0006](adr/0006-plugins-as-entitlements.md)).
- **Extensibility model.** Makerkit = "fork the kit, edit the schema." TenantKit = "consume the packages, add
  plugins with their own schemas + entitlement gating" ([ADR‑0010](adr/0010-two-layer-packaging-and-oss-repos.md)).

## 7. What each does better

**Makerkit is stronger when:**
- You want personal‑account → upgrade‑to‑team with zero migration (unified `accounts`).
- You're all‑in on Supabase and want billing, roles, invitations, and admin already wired in `public`.
- You want roles/permissions editable as data without redeploying.
- URL‑addressable workspaces (`/home/[account]`) fit your UX.

**TenantKit is stronger when:**
- You need **portability** off Supabase (Neon/RDS/self‑hosted) — the `current_user_id()` seam + ports/adapters.
- `tenant = organization` should be an unambiguous invariant (no personal‑account ambiguity).
- You have a **second class of end‑customer** that needs scoped self‑service (the family/participant model).
- You want **`own` vs `any` row scoping enforced in RLS**, not reimplemented per table.
- You want **subdomain / custom‑domain** tenancy out of the box (`core.tenant_domains`, host‑based resolution).
- You want billing/SMS/etc. as **optional, entitlement‑gated plugins** with isolated schemas.

## 8. Ideas worth borrowing from Makerkit

1. **`roles` / `role_permissions` as tables** (not just an enum + app map) — would let a tenant customize roles
   without a deploy. TenantKit already calls the grant map "data, not code" ([04 §3](04-roles-and-permissions.md));
   moving it into a `core.role_permissions` table (still evaluated by `can()`) would close the gap while keeping
   the `own/any` scope column TenantKit adds on top.
2. **Optional personal workspace** — if TenantKit ever wants solo users before they create a studio, Makerkit's
   `is_personal_account` discriminator is the proven pattern (though it would dilute the org‑only invariant —
   probably keep it as a *separate* concept rather than overloading `core.tenants`).
3. **`is_account_owner` convenience predicate** — TenantKit has `my_role`/`is_member_of`; a thin
   `is_tenant_owner(tenant)` could simplify a few owner‑only policies.

Conversely, the things TenantKit does that a Makerkit‑based project would have to add by hand: the vendor‑free
`current_user_id()` seam, the relational family actor, RLS‑level `own/any` scoping, plugin schema isolation, and
the platform‑operator grant kept *outside* tenant RLS.

---

[database‑architecture]: https://makerkit.dev/docs/next-supabase-turbo/development/database-architecture
[permissions‑and‑roles]: https://makerkit.dev/docs/next-supabase-turbo/permissions-and-roles
[RLS best practices]: https://makerkit.dev/blog/tutorials/supabase-rls-best-practices
</content>
</invoke>
