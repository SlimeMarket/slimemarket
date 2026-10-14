-- ---------------------------------------------------------------------------
-- 0077 — SECURITY: lock down sql_simple_query.
--
-- WHAT WAS WRONG
-- --------------
-- `sql_simple_query` (migration 0059) is a generic SQL executor:
--
--     EXECUTE 'SELECT ... FROM (' || query || ') t' INTO result
--
-- It is declared SECURITY DEFINER, so it runs with the privileges of its owner
-- rather than the caller — which means it does NOT respect row-level security.
-- And its default ACL granted EXECUTE to PUBLIC, which PostgREST exposes to
-- **anon** and **authenticated**:
--
--     =X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/postgres
--
-- Together that is a full database read for anyone holding the public anon key —
-- no account, no session, nothing. `select * from users`, `secret_vault`,
-- `wallet_txs`, `mm_audit_log`… all of it. The anon key ships in the browser
-- bundle by design, so this was reachable by any visitor.
--
-- THE FIX
-- -------
--  1. Revoke EXECUTE from PUBLIC / anon / authenticated; keep only service_role.
--     The single caller is the admin dashboard, which uses the service-role key.
--  2. Pin `search_path` on the SECURITY DEFINER function. Without it, a caller
--     who can create objects in a schema earlier on the path can hijack the
--     unqualified references inside the function.
--
-- After this, the function is callable only from trusted server code.
-- ---------------------------------------------------------------------------

revoke all on function public.sql_simple_query(text) from public;
revoke all on function public.sql_simple_query(text) from anon;
revoke all on function public.sql_simple_query(text) from authenticated;
grant execute on function public.sql_simple_query(text) to service_role;

-- Pin the search path so unqualified names inside the function cannot be
-- resolved to attacker-controlled objects.
alter function public.sql_simple_query(text) set search_path = pg_catalog, public;

comment on function public.sql_simple_query(text) is
  'SECURITY DEFINER generic SELECT executor. service_role ONLY — granting this to anon/authenticated exposes the entire database. Added 0077.';

-- ---------------------------------------------------------------------------
-- Audit: report any OTHER SECURITY DEFINER function still executable by anon or
-- authenticated. Each one is a potential RLS bypass; this makes them visible
-- instead of silently accumulating.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.proname
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosecdef
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     order by p.proname
  loop
    n := n + 1;
    raise warning 'SECURITY DEFINER function still callable by anon/authenticated: %', r.proname;
  end loop;
  if n = 0 then
    raise notice 'OK: no SECURITY DEFINER function is callable by anon/authenticated.';
  else
    raise notice 'Review needed: % SECURITY DEFINER function(s) exposed.', n;
  end if;
end $$;
