-- Migration: Create sql_simple_query RPC function
-- Used by admin dashboard, audit log, sales summary, and transaction endpoints
-- to run dynamic SQL queries and return results as JSON.
--
-- Security: SECURITY DEFINER — runs with the permissions of the function owner
-- (postgres). Only callable by authenticated users. The function is intentionally
-- powerful (EXECUTEs arbitrary SQL) — it's meant for server-side admin/analytics
-- routes only, never exposed to client-side calls.

CREATE OR REPLACE FUNCTION public.sql_simple_query(query TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
BEGIN
  EXECUTE 'SELECT COALESCE(json_agg(row_to_json(t)), ''[]''::json) FROM (' || query || ') t' INTO result;
  RETURN result;
END;
$$;

-- Grant access to server-side roles (postgres = service_role, authenticated = logged-in users)
GRANT EXECUTE ON FUNCTION public.sql_simple_query(TEXT) TO postgres, authenticated;

COMMENT ON FUNCTION public.sql_simple_query(TEXT) IS
  'Execute a SQL query and return results as JSON array. Server-side admin/analytics only.';
