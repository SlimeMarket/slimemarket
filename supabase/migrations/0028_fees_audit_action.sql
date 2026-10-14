-- ============================================================================
-- 0028_fees_audit_action — widen mm_audit_log action CHECK for COLLECT_FEES.
--
-- F4 (on-chain fee collection) records a COLLECT_FEES audit entry when the
-- treasury sweeps accrued pendingFees via collectFees(). The prior CHECK
-- (0023) did not include it, so the insert would violate the constraint.
-- Append-only audit table; this only widens the allowed action set.
-- ============================================================================

alter table mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table mm_audit_log add constraint mm_audit_log_action_check
  check (action in (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','MM_PROMOTE','MM_DEMOTE',
    'BAN_USER','UNBAN_USER','FREEZE_PRODUCT','UNFREEZE_PRODUCT',
    'FREEZE_STORE','UNFREEZE_STORE','REVOKE_SELLER','COLLECT_FEES'
  ));
