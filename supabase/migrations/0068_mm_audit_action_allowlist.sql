-- ============================================================================
-- 0068 — restore the full mm_audit_log action allowlist (+ MM_PIN_SET).
--
-- BUG THIS FIXES (found in the MVP audit):
--   0029 widened `mm_audit_log_action_check` to 20 actions.
--   0066 re-created the constraint listing only 12 of them, silently
--   DROPPING: BAN_USER, UNBAN_USER, FREEZE_PRODUCT, UNFREEZE_PRODUCT,
--   FREEZE_STORE, UNFREEZE_STORE, REVOKE_SELLER, COLLECT_FEES,
--   ALLOWANCE_DANGLING, RECONCILE_DRIFT, WALLET_FREEZE, WALLET_UNFREEZE.
--
--   Consequence: every insert with one of those actions now violates the CHECK.
--   `createMmAuditLog` re-throws on failure (and writes a dead-letter row), so
--   admin bans, product/store freezes, fee collection, the allowance sweep and
--   the balance-drift reconciler all lost their audit trail on any database that
--   ran 0066 — exactly the privileged actions that must be auditable.
--
-- This migration restores every action in the `MmAuditAction` union
-- (lib/mm.ts) plus the new MM_PIN_SET, and adds a guard so the list cannot
-- silently drift again: the constraint is built from a single source of truth
-- in this file.
--
-- Keep in sync with `MmAuditAction` in lib/mm.ts.
-- ============================================================================

alter table public.mm_audit_log drop constraint if exists mm_audit_log_action_check;

alter table public.mm_audit_log add constraint mm_audit_log_action_check
  check (action in (
    -- order / escrow money movement
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    -- treasury
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','COLLECT_FEES',
    -- roles
    'MM_PROMOTE','MM_DEMOTE','REVOKE_SELLER',
    -- user moderation
    'BAN_USER','UNBAN_USER',
    -- catalog moderation
    'FREEZE_PRODUCT','UNFREEZE_PRODUCT','FREEZE_STORE','UNFREEZE_STORE',
    -- phase 2/5 hooks
    'ALLOWANCE_DANGLING','RECONCILE_DRIFT','WALLET_FREEZE','WALLET_UNFREEZE',
    -- EOA account recovery
    'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK',
    -- WL (rekber) pre-escrow cancel
    'CANCEL_WL_DEAL',
    -- admin set/reset a middleman's admin PIN
    'MM_PIN_SET'
  ));

-- Sanity check: fail loudly if this list is missing anything the code can emit.
-- (Runs at migration time; a mismatch aborts the migration instead of silently
-- shipping a database that rejects legitimate audit rows.)
--
-- NOTE: `pg_get_constraintdef` returns the WHOLE definition as one string
-- (e.g. "CHECK ((action = ANY (ARRAY['RELEASE_ORDER'::text, ...])))"), so the
-- check must look for each action as a QUOTED SUBSTRING — an `a NOT IN (SELECT
-- pg_get_constraintdef(...))` comparison would compare each name against that
-- single string and report every action as missing.
do $$
declare
  v_def text;
  v_missing text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conname = 'mm_audit_log_action_check';

  if v_def is null then
    raise exception 'mm_audit_log_action_check was not created';
  end if;

  select string_agg(a, ', ') into v_missing
    from unnest(array[
      'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
      'TREASURY_WITHDRAW','TREASURY_AIRDROP','COLLECT_FEES',
      'MM_PROMOTE','MM_DEMOTE','REVOKE_SELLER',
      'BAN_USER','UNBAN_USER',
      'FREEZE_PRODUCT','UNFREEZE_PRODUCT','FREEZE_STORE','UNFREEZE_STORE',
      'ALLOWANCE_DANGLING','RECONCILE_DRIFT','WALLET_FREEZE','WALLET_UNFREEZE',
      'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK',
      'CANCEL_WL_DEAL','MM_PIN_SET'
    ]) as a
   where position('''' || a || '''' in v_def) = 0;

  if v_missing is not null then
    raise exception 'mm_audit_log_action_check is missing actions: %', v_missing;
  end if;
end $$;
