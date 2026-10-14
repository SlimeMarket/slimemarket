-- 0092 — restore the WL deal audit actions dropped by 0083
--
-- SYMPTOM (reproduced on the live database, not inferred):
--
--   select action, count(*), max(failure_reason) from mm_audit_log_failed group by action;
--     WL_DEAL_DISPUTED  | 2 | violates check constraint "mm_audit_log_action_check"
--     WL_DEAL_DELIVERED | 1 | violates check constraint "mm_audit_log_action_check"
--
--   mm_audit_log holds 84 rows; none of them is a WL deal event.
--
-- ROOT CAUSE — a silent regression across three migrations:
--
--   0072 added 'WL_DEAL_DELIVERED','WL_DEAL_DISPUTED','SLASH_COLLATERAL'
--   0074 added 'WL_DEAL_PAID','WL_DEAL_PAYMENT_CONFIRMED'
--   0083 RE-DECLARED the whole constraint from scratch and listed only
--        'SLASH_COLLATERAL' — dropping the four WL_DEAL_* values it did not
--        happen to be thinking about. 0083's own comment even mentions
--        "the WL_DEAL_* audit calls", so the author knew they existed.
--
-- WHY IT MATTERED AND STAYED HIDDEN: every one of the four call sites in
-- lib/wl/transitions.ts wraps `createMmAuditLog` in `.catch(() => {})`
-- (markDealDelivered, markDealPaid, confirmDealPayment, flagDispute). So the
-- insert failed, the dead-letter row was written, the throw was swallowed and
-- the request returned 200. The user saw success; the audit trail silently
-- lost every WL deal lifecycle event.
--
-- That trail is the platform's evidence for dispute arbitration — the very
-- thing the WL flow exists to make trustworthy. `markDelivered` and
-- `flagDispute` are exactly the two events an arbitrator needs.
--
-- THE RULE THIS VIOLATED: re-declaring a CHECK constraint from scratch means
-- the new list is the whole truth. Anything the author was not thinking about
-- at that moment disappears, and nothing fails — the constraint just gets
-- narrower. Widen by ADDING to the existing set, or re-declare the full set.
-- `__tests__/lib/mm-audit-action-check.test.ts` now pins this: the last
-- `mm_audit_log_action_check` in the migration history must cover every value
-- of the app's `MmAuditAction` union.

begin;

alter table mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table mm_audit_log add constraint mm_audit_log_action_check check (action in (
  -- marketplace orders / escrow
  'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
  -- treasury
  'TREASURY_WITHDRAW','TREASURY_AIRDROP','COLLECT_FEES',
  -- middleman roster
  'MM_PROMOTE','MM_DEMOTE','REVOKE_SELLER','MM_PIN_SET',
  -- users / stores / products
  'BAN_USER','UNBAN_USER',
  'FREEZE_PRODUCT','UNFREEZE_PRODUCT','FREEZE_STORE','UNFREEZE_STORE',
  -- reconciliation + wallet state
  'ALLOWANCE_DANGLING','RECONCILE_DRIFT','WALLET_FREEZE','WALLET_UNFREEZE',
  -- account recovery
  'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK',
  -- WL (rekber) deal lifecycle — the four restored by this migration
  'CANCEL_WL_DEAL',
  'WL_DEAL_DELIVERED','WL_DEAL_DISPUTED','WL_DEAL_PAID','WL_DEAL_PAYMENT_CONFIRMED',
  -- fraud: seller collateral forfeited to the buyer
  'SLASH_COLLATERAL'
));

-- Recover the entries that 0083 onward pushed into the dead-letter table. They
-- are the only surviving record of those WL deal events, so replaying them
-- restores the trail instead of leaving a permanent hole.
--
-- Column mapping notes (the two tables are NOT shaped alike):
--   * the dead-letter table has `attempted_at`, not `created_at`
--   * it stores `mm_user_id` as text, while mm_audit_log wants a uuid
--   * its mm_wallet_id / actor_type / ref_id are nullable, while the log's are
--     NOT NULL — so each needs a coalesce to survive the copy
insert into mm_audit_log (
  mm_user_id, mm_wallet_id, actor_type, action, ref_id,
  tx_hash, circle_tx_id, detail, created_at
)
select
  -- Cast defensively: a malformed value would abort the whole migration.
  case
    when f.mm_user_id ~ '^[0-9a-fA-F-]{36}$' then f.mm_user_id::uuid
    else null
  end,
  coalesce(f.mm_wallet_id, ''),
  coalesce(f.actor_type, 'system'),
  f.action,
  coalesce(f.ref_id, ''),
  f.tx_hash,
  f.circle_tx_id,
  f.detail,
  f.attempted_at
from mm_audit_log_failed f
where f.action in (
  'WL_DEAL_DELIVERED','WL_DEAL_DISPUTED','WL_DEAL_PAID','WL_DEAL_PAYMENT_CONFIRMED'
)
-- Idempotent: re-running must not duplicate the replayed rows. `attempted_at`
-- is the dead-letter row's only timestamp, so it is what identifies the copy.
and not exists (
  select 1 from mm_audit_log m
  where m.action = f.action
    and m.ref_id = coalesce(f.ref_id, '')
    and m.created_at = f.attempted_at
);

commit;
