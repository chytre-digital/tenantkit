# ADR-0008 — RLS via `is_member_of()`

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** security, data-model, rls

## Context

Tenant isolation is a **database invariant** in this system: RLS is the second gate behind `withRoute`, and
default-deny is on every table. The membership check — "is the current user a member of this tenant, at at
least role X?" — is therefore the single most-repeated predicate in the schema, appearing in the `USING`/`WITH
CHECK` clause of essentially every tenant-scoped policy.

Both reference apps wrote this check as an **inline subquery** against their membership table, copy-pasted
across dozens of policies. This caused real harm: `admin-console` hit Postgres's **"infinite recursion in
policy"** error, because a policy on the membership table that itself queried the membership table re-entered
its own RLS. Inline duplication also means a change to the membership/role logic must be edited in many
places, and the two apps' copies have already drifted. We want **one** predicate, recursion-safe, consumed by
every policy and reused across apps via `reservation-core`.

## Decision

Provide **one** membership predicate in `@reservation-core/db`, marked **`SECURITY DEFINER`** so it does not
re-trigger RLS on the membership table:

```sql
create function core.is_member_of(p_tenant uuid, p_min_role text default 'staff')
  returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant and m.user_id = auth.uid()
      and core.role_rank(m.role) >= core.role_rank(p_min_role))
$$;
```

Every tenant-scoped table's policy reads `using (core.is_member_of(tenant_id))` (with a higher `min_role` in
`with check` where writes need it) — **no inline subquery, no recursion**. The **membership table's own
policies stay self-row-only** (a user sees/edits only their own membership rows), so they never call the
helper and the recursion is structurally impossible. The family side has the parallel
`can_act_for_participant(participant)` ([ADR-0007](0007-participant-accounts.md)).

## Consequences

**Positive:** DRY isolation — one predicate to read, test (pgTAP/SQL), and reason about; the recursion
incident cannot recur by construction; role-rank logic lives in one place and is shared across apps; policies
become short and obviously correct.
**Negative / costs:** `SECURITY DEFINER` must be written and reviewed carefully (it runs as owner — its body
is the trust boundary); a bug here is system-wide, so it gets dedicated tests; developers must understand why
the membership table itself must *not* use the helper.
**Follow-ups:** pgTAP coverage for `is_member_of` and the self-row-only membership policies; `role_rank()`
and the policy macros in [03](../03-data-model.md); apply the same pattern when refactoring the reference
apps onto the core.

## Alternatives considered

- **Inline subqueries (status quo).** No new function, but is exactly what caused the recursion incident and
  the cross-app drift. Rejected.
- **App-layer-only membership checks.** Keeps SQL simple, but throws away the database invariant — a single
  `withRoute` bug would then leak cross-tenant data. Rejected; RLS is belt-and-suspenders by design.
- **A JWT custom-claims hook carrying memberships in the token.** Fast (no per-query lookup), but tokens go
  stale on role/membership changes, bloat with many tenants, and move authorization into token-issuance.
  Rejected as the source of truth (may cache hints later).
