-- 0083 — make the SLASH path writable (two CHECK constraints were missing values)
--
-- `slashDeal` (lib/wl/transitions.ts) writes two values that neither constraint
-- allowed. Because the second write is a bare `.update(...)` whose error is never
-- inspected, it failed SILENTLY and execution continued to the audit insert,
-- which then threw — so the caller got a 502 *after* the DB transition had
-- already committed and the on-chain relay had already been fired.
--
--   BUG A — mm_audit_log.action had no 'SLASH_COLLATERAL'
--     await createMmAuditLog({ action: "SLASH_COLLATERAL", ... })   → 23514
--     This one is awaited WITHOUT .catch(), unlike the WL_DEAL_* audit calls,
--     so it aborted the whole operation.
--
--   BUG B — wl_deals.on_chain_status had no 'slash_pending'
--     .update({ on_chain_status: "slash_pending" })                 → 23514
--     Silently ignored, leaving the row reporting CREATED while a slash was in
--     flight — i.e. the reconciliation job had no way to see the pending slash.
--
-- Net effect: fraud slashing could never complete. The seller's collateral was
-- never forfeited to the buyer, which is the entire point of requiring
-- collateral on high-risk WL deals.

-- ---------------------------------------------------------------------------
-- BUG A — allow the slash action in the middleman audit log
-- ---------------------------------------------------------------------------
alter table mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table mm_audit_log add constraint mm_audit_log_action_check check (action in (
  'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
  'TREASURY_WITHDRAW','TREASURY_AIRDROP','COLLECT_FEES',
  'MM_PROMOTE','MM_DEMOTE','REVOKE_SELLER','BAN_USER','UNBAN_USER',
  'FREEZE_PRODUCT','UNFREEZE_PRODUCT','FREEZE_STORE','UNFREEZE_STORE',
  'ALLOWANCE_DANGLING','RECONCILE_DRIFT','WALLET_FREEZE','WALLET_UNFREEZE',
  'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK',
  'CANCEL_WL_DEAL','MM_PIN_SET',
  -- fraud: seller collateral forfeited to the buyer
  'SLASH_COLLATERAL'
));

-- ---------------------------------------------------------------------------
-- BUG B — allow the pending-slash on-chain state
-- ---------------------------------------------------------------------------
alter table wl_deals drop constraint if exists wl_deals_on_chain_status_check;
alter table wl_deals add constraint wl_deals_on_chain_status_check check (
  on_chain_status is null or on_chain_status in (
    'CREATED','create_pending','release_pending','refund_pending',
    'RELEASED','REFUNDED','release_failed','refund_failed',
    -- slash relay accepted on-chain, DB transition still settling
    'slash_pending'
  )
);
