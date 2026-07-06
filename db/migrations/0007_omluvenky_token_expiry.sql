-- SHIPPED REFERENCE — named expiry tokens ("tokeny platnosti") as shipped in terminar (2026-07), extending the
-- 0006 omluvenky subset (docs/08 §14 "Named tokens"). Verbatim source of this file:
-- terminar/supabase/migrations/20260706150000_core_token_expiry.sql.
--
-- Named expiry tokens — a 4th expiry mode for omluvenky. The studio keeps a catalog in
-- core.tenants.settings.excusalCredits.tokens = [{"id","name","validUntil":"YYYY-MM-DD"}, ...]; a course pins
-- one via excuse_policy = {"expiry":{"mode":"token","tokenId":...}} and the tenant default may itself be
-- {"mode":"token","tokenId":...}. The token's date is resolved from the catalog AT MINT TIME (reference
-- semantics: moving a token's date moves FUTURE mints from every assigned course; issued credits keep their
-- stamped expires_at — the existing invariant). validUntil is INCLUSIVE end-of-day Europe/Prague, matching the
-- live inclusive redeemability gate (expires_at >= now()).
--
-- Fallback ladder (per the owner's decision): a token that is MISSING from the catalog or already EXPIRED at
-- mint falls to the NEXT candidate — course override → tenant default → ttl-30. Every non-token mode still
-- resolves immediately exactly as before (none → null; course_end → last session start; ttl/unknown → ttl-30),
-- so pre-token behavior is bit-identical. TS mirror: reservation-core credits resolveCreditExpiry (0.3.0).

create or replace function core.compute_credit_expiry(p_tenant uuid, p_course uuid, p_issued_at timestamptz)
  returns timestamptz language plpgsql stable security definer set search_path = core as $$
declare
  v_settings    jsonb;
  v_course_pol  jsonb;
  v_default_pol jsonb;
  v_policy      jsonb;
  v_mode        text;
  v_valid_until date;
  v_end         timestamptz;
begin
  select excuse_policy -> 'expiry' into v_course_pol from core.courses where id = p_course;
  select settings into v_settings from core.tenants where id = p_tenant;
  v_default_pol := v_settings #> '{excusalCredits,defaultExpiry}';

  if jsonb_typeof(v_course_pol)  is distinct from 'object' then v_course_pol  := null; end if;
  if jsonb_typeof(v_default_pol) is distinct from 'object' then v_default_pol := null; end if;

  foreach v_policy in array array[v_course_pol, v_default_pol] loop
    continue when v_policy is null;
    v_mode := coalesce(v_policy ->> 'mode', 'ttl');

    if v_mode = 'none' then
      return null;
    elsif v_mode = 'course_end' then
      return (select max(starts_at) from core.sessions where course_id = p_course);
    elsif v_mode = 'token' then
      select (t.value ->> 'validUntil')::date into v_valid_until
        from jsonb_array_elements(coalesce(v_settings #> '{excusalCredits,tokens}', '[]'::jsonb)) as t(value)
       where t.value ->> 'id' = v_policy ->> 'tokenId'
         and (t.value ->> 'validUntil') ~ '^\d{4}-\d{2}-\d{2}$'
       limit 1;
      if v_valid_until is not null then
        -- inclusive end-of-day Prague = local midnight of the NEXT day minus 1s (DST-safe: `at time zone`
        -- on a bare timestamp INTERPRETS it as Prague local → 2026-12-31 ⇒ 22:59:59+00 = 23:59:59 CET).
        v_end := ((v_valid_until + 1)::timestamp at time zone 'Europe/Prague') - interval '1 second';
        if v_end >= p_issued_at then
          return v_end;
        end if;
      end if;
      -- token missing from the catalog or expired at mint → next candidate
    else  -- 'ttl' (and any unknown mode degrades to the safe default)
      return p_issued_at + make_interval(days => coalesce((v_policy ->> 'ttlDays')::int, 30));
    end if;
  end loop;

  return p_issued_at + interval '30 days';  -- no candidates left (absent policies or dead tokens all the way)
end $$;
revoke execute on function core.compute_credit_expiry(uuid, uuid, timestamptz) from public;
grant  execute on function core.compute_credit_expiry(uuid, uuid, timestamptz) to service_role;
