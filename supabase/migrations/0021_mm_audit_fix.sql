-- ============================================================================
-- 0021_mm_audit_fix — allow backend inserts into mm_audit_log + widen actions.
--
-- Fixes: "permission denied for table mm_audit_log" on the on-chain release/
-- refund path, and CHECK violations for treasury/role audit actions.
--
-- mm_audit_log is a BACKEND-ONLY append-only table (written via the service
-- client). RLS stays ON with select denied to client roles; we add an explicit
-- INSERT policy + grants so the server can write, and reads go through the
-- server (service role bypasses the deny-select policy).
-- ============================================================================

-- 1) Grants for the backend service role (and postgres migration role).
grant insert, select on table mm_audit_log to service_role;
grant insert, select on table mm_audit_log to postgres;

-- 2) Allow inserts under RLS (server-side writes). Reads remain denied to client
--    roles via the existing mm_audit_log_deny select policy.
drop policy if exists mm_audit_log_insert on mm_audit_log;
create policy mm_audit_log_insert on mm_audit_log for insert with check (true);

-- 3) Widen the action check to cover treasury + role-change audit events
--    (lib/mm.ts emits these; the original 0013 check only allowed 4).
alter table mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table mm_audit_log add constraint mm_audit_log_action_check
  check (action in (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','MM_PROMOTE','MM_DEMOTE'
  ));
