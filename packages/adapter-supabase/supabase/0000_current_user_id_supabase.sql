-- @tenantkit/adapter-supabase — Supabase binding for the portable identity seam.
--
-- The kernel's RLS predicates call core.current_user_id() (NOT auth.uid()) so the SAME policies run on any
-- Postgres (see packages/reservation-core/src/db/index.ts + docs/14 §3.1). On SUPABASE you have two options:

-- OPTION A (recommended): keep the portable dual-path function shipped by the kernel as-is. It already reads
--   request.jwt.claims -> 'sub', which PostgREST sets from the user's JWT. Nothing to do here. Most portable.

-- OPTION B: if you only ever run on Supabase and prefer the native helper, alias the function to auth.uid():
create or replace function core.current_user_id()
  returns uuid language sql stable as $$
  select auth.uid()
$$;

-- Either way, apply this AFTER the kernel core migration (which creates the core schema + the predicates).
--
-- Supabase project settings reminder:
--   • Project → API → "Exposed schemas": add `core` (and `public`) so the adapter's .schema('core') reads work,
--     OR keep core unexposed and reach it only via SECURITY DEFINER RPCs (more locked-down).
--   • Auth → set the JWT to include `sub` (default). No custom access-token hook is required: memberships are
--     resolved by the kernel's AuthzStore, not carried in the JWT.
