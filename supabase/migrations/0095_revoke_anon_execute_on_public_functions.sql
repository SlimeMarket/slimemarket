-- ============================================================================
-- SlimeMarket — 0095: no function in `public` is callable by anon.
--
-- WHY THIS EXISTS
-- ---------------
-- Supabase ships DEFAULT PRIVILEGES that grant EXECUTE on every NEW function in
-- `public` to anon, authenticated and service_role:
--
--     postgres | f | {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- A migration that creates a function and then does only
--
--     REVOKE ALL ON FUNCTION … FROM PUBLIC;
--
-- therefore does NOT remove those explicit grants: the function stays callable
-- by anyone holding the public anon key, which ships in the browser bundle by
-- design. For a SECURITY DEFINER function that is a full database read — it runs
-- with the OWNER's privileges and bypasses RLS entirely.
--
-- This is not hypothetical. It is exactly what the `pg_dump --schema-only`
-- restore path produced: pg_dump emits only `REVOKE ALL ON FUNCTION … FROM
-- PUBLIC` (it compares against PostgreSQL's BUILT-IN default, not Supabase's
-- configured one), so a freshly restored database came back with 56 functions
-- anon-executable, including every SECURITY DEFINER one.
--
-- WHY "ALL FUNCTIONS" AND NOT JUST SECURITY DEFINER
-- -------------------------------------------------
-- The intended state has no function reachable with the anon key, and this was
-- verified before widening the revoke:
--   - no RLS policy references any of the helper functions
--     (`select … from pg_policies where qual like '%current_user_id%'` → 0 rows)
--   - no client code calls them (grep over public/, app/, lib/ → no hits)
--   - the app reaches the database exclusively through Next.js API routes using
--     the service_role key, which keeps EXECUTE
-- Trigger functions (`set_updated_at`, `increment_access_count`, …) are invoked
-- by the trigger machinery, not by the caller, so they need no caller EXECUTE.
--
-- Idempotent: safe on every deploy, and a no-op on a database already correct.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      r.sig
    );
  end loop;
end $$;
