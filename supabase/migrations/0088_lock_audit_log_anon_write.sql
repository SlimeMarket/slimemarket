-- 0088 — close UNAUTHENTICATED write access to the MM audit log
--
-- FINDING (2026-10-06): `mm_audit_log` and `mm_audit_log_failed` each carried a
-- PERMISSIVE INSERT policy with `WITH CHECK (true)` granted to role PUBLIC —
-- which includes `anon`. Paired with the anon INSERT grant that ships with the
-- public schema, an UNAUTHENTICATED caller could write arbitrary rows through
-- PostgREST. Proven against the live database, not inferred:
--
--   POST /rest/v1/mm_audit_log      (anon publishable key, no session) -> 201
--   INSERT ... ; SET LOCAL ROLE anon (psql)                            -> INSERT 0 1
--
-- WHY IT MATTERS: `mm_audit_log` is the platform's evidence trail — it records
-- who released escrow, who slashed collateral, who froze an account. It backs
-- dispute arbitration and operator accountability. Letting anyone forge or
-- flood it defeats the point of having it, and an unbounded INSERT is also a
-- cheap write-DoS on the table.
--
-- WHY DROPPING IS SAFE: the only writer is `createMmAuditLog()` (lib/mm.ts),
-- which goes through `supabaseAdminClient()` — the SERVICE ROLE — and therefore
-- bypasses RLS entirely. Nothing in the app relies on this policy, so it
-- protects nothing and only widens the attack surface. Reads stay closed too:
-- `mm_audit_log_deny` is `USING (false)` and the admin UI reads server-side via
-- /api/admin/audit.
--
-- The second block is defence in depth: with the table grants gone, a future
-- policy mistake cannot silently re-open the hole.

begin;

drop policy if exists mm_audit_log_insert on public.mm_audit_log;
drop policy if exists mm_audit_log_failed_insert on public.mm_audit_log_failed;

revoke insert, update, delete on public.mm_audit_log from anon, authenticated;
revoke insert, update, delete on public.mm_audit_log_failed from anon, authenticated;

commit;
