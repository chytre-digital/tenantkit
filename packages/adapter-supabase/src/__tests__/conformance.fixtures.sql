-- Conformance fixtures — apply to the DISPOSABLE Supabase test project AFTER the kernel core migration
-- (db/migrations/0001_core.sql). These give the port-conformance DB-scoping suite (and the hybrid cookie/Bearer
-- RLS tests) a real, RLS-guarded domain table to count against, so "user A cannot see tenant B's rows" is a
-- genuine Postgres RLS result rather than an application-layer mock.
--
-- Nothing here is part of TenantKit's core schema; it exists only for the adapter's integration test lane.
-- The test project must also expose the `core` schema (Project → API → Exposed schemas) so the harness can seed
-- via `.schema('core')`, and `public` (default) for `courses` / `count_courses`.

create extension if not exists pgcrypto;

-- A minimal tenant-scoped domain table. RLS ties visibility to core membership, exactly like a real app table.
create table if not exists public.courses (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.courses enable row level security;

drop policy if exists courses_member_read on public.courses;
create policy courses_member_read on public.courses
  for select using (core.is_member_of(tenant_id));

-- Count rows for a tenant AS THE CALLER (SECURITY INVOKER): the inner select is subject to RLS, so a non-member
-- counts 0 while the service role (RLS bypass) counts all. Param name is `tenant_id` to match the RPC call
-- `rpc('count_courses', { tenant_id })`. Returns `{ "count": <n> }` to mirror the in-memory harness shape.
create or replace function public.count_courses(tenant_id uuid)
  returns json language sql stable security invoker
  set search_path = public, core as $$
  select json_build_object('count', (select count(*)::int from public.courses c where c.tenant_id = count_courses.tenant_id))
$$;

-- Let the anon/authenticated roles execute the counter (RLS still gates what it can see).
grant usage on schema public to anon, authenticated;
grant select on public.courses to anon, authenticated;
grant execute on function public.count_courses(uuid) to anon, authenticated, service_role;
