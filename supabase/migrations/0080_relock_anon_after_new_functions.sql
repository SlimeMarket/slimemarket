-- ============================================================================
-- 0080_relock_anon_after_new_functions — re-run the 0078 lockdown
--
-- WHY THIS EXISTS
--   0078 closed every hole where a SECURITY DEFINER function was reachable with
--   the PUBLIC anon key. It also ends with an assertion that fails the migration
--   if any such function is still exposed.
--
--   But 0078 runs BEFORE 0079 — and 0079 creates two new SECURITY DEFINER
--   functions (`pop_stock_fifo_auto`, `pop_one_stock_item`). Postgres grants
--   EXECUTE to PUBLIC by default, so those two were born anon-callable and 0078's
--   assertion had already passed. Nothing re-checked afterwards.
--
--   Impact: `pop_one_stock_item` consumes a credential from a seller's stock.
--   Reachable with the anon key, so anyone could drain seller inventory without
--   logging in or paying:
--
--     POST /rest/v1/rpc/pop_one_stock_item
--       {"p_product_id":"<uuid>","p_variant_label":"Default"}
--     → 200 "NFLX-0006-1679"      ← a real credential, no auth required
--
-- FIX
--   1. Re-run the 0078 sweep so every SECURITY DEFINER function in `public` is
--      locked to service_role only.
--   2. Keep the assertion, so this class of hole can never pass silently again.
--
-- NOTE: 0079 now also revokes explicitly, so a fresh database is never exposed
-- even transiently. This migration is the safety net for anything added later —
-- any migration that creates a function should be followed by a sweep like this,
-- or the function should revoke PUBLIC itself.
-- ============================================================================

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
    raise notice '0080: locked %', r.sig;
  end loop;
  raise notice '0080: locked down % SECURITY DEFINER function(s) that 0078 could not see.', n;
end $$;

-- Assertion — same invariant as 0078, re-checked after 0079 created functions.
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
    raise exception '0080 FAILED: % SECURITY DEFINER function(s) still callable by anon/authenticated', fn;
  end if;
  if tbl > 0 then
    raise exception '0080 FAILED: % table(s) still have RLS disabled', tbl;
  end if;
  raise notice '0080 OK: no SECURITY DEFINER function is anon-callable and every table has RLS.';
end $$;
