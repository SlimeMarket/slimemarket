-- ---------------------------------------------------------------------------
-- 0078 — SECURITY: close the anon/authenticated data exposure.
--
-- WHAT WAS WRONG
-- --------------
-- Two independent holes, both reachable with the PUBLIC anon key (which ships in
-- the browser bundle by design, so "reachable" means "by any visitor"):
--
--   1. 51 of the 52 SECURITY DEFINER functions in `public` granted EXECUTE to
--      anon + authenticated. A SECURITY DEFINER function runs as its OWNER, so
--      it does NOT apply row-level security. Combined with a public grant that
--      is a complete RLS bypass — including money-moving RPCs such as
--      `treasury_payout_atomic`, `settle_wl_deal_after_timeout` and
--      `slash_wl_deal_noncustodial`.
--
--   2. 8 tables had row security DISABLED entirely while still granting anon
--      full DML (SELECT/INSERT/UPDATE/DELETE/TRUNCATE). For those, the grant is
--      live: `temp_reset_codes` (password-reset codes) and `reports` among them.
--
-- WHY REVOKING IS SAFE HERE
-- -------------------------
-- The browser never talks to Supabase directly — there is no supabase-js client
-- in `public/`. Every read and write goes through the Next.js API routes, which
-- use the SERVICE ROLE key. service_role bypasses RLS and keeps its grants, so
-- revoking anon/authenticated cannot break the app.
--
-- This migration is idempotent: it revokes from every matching object rather than
-- naming them, so functions and tables added later are covered by re-running it.
-- ---------------------------------------------------------------------------

-- ---- 1. SECURITY DEFINER functions -----------------------------------------
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosecdef
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    n := n + 1;
  end loop;
  raise notice '0078: locked down % SECURITY DEFINER function(s).', n;
end $$;

-- Pin search_path on every SECURITY DEFINER function that lacks one. Without it a
-- caller who can create objects in an earlier schema can hijack the function's
-- unqualified references.
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosecdef
       and (p.proconfig is null
            or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
  loop
    execute format('alter function %s set search_path = pg_catalog, public', r.sig);
    n := n + 1;
  end loop;
  raise notice '0078: pinned search_path on % SECURITY DEFINER function(s).', n;
end $$;

-- ---- 2. Tables with row security disabled ----------------------------------
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select tablename from pg_tables
     where schemaname = 'public' and not rowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
    n := n + 1;
    raise notice '0078: enabled RLS on public.%', r.tablename;
  end loop;
  raise notice '0078: enabled RLS on % table(s).', n;
end $$;

-- With RLS on and no permissive policy, anon/authenticated see nothing; the API's
-- service_role connection is unaffected (it bypasses RLS by design).

-- ---- 3. Verify -------------------------------------------------------------
do $$
declare
  fn int;
  tbl int;
begin
  select count(*) into fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select count(*) into tbl
    from pg_tables where schemaname = 'public' and not rowsecurity;

  if fn > 0 then
    raise exception '0078 FAILED: % SECURITY DEFINER function(s) still callable by anon/authenticated', fn;
  end if;
  if tbl > 0 then
    raise exception '0078 FAILED: % table(s) still have RLS disabled', tbl;
  end if;
  raise notice '0078 OK: no SECURITY DEFINER function is anon-callable and every table has RLS.';
end $$;
