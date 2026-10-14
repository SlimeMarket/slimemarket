-- ============================================================================
-- 0069 — wallet_txs: add the 'onchain-ucw' method.
--
-- . The UCW-challenge withdrawal path (`lib/wallet/ucw-send.ts`) records a
-- pending `wallet_txs` row at challenge time and relies on the frontend calling
-- back with the on-chain txHash to settle it. If the browser dies in between,
-- nothing ever settles it:
--   * the row had NO `circle_tx_id`, and `reconcileFailedWithdrawals` requires
--     one — so the row was invisible to every sweep;
--   * it could not be distinguished from a DCW-path withdrawal either.
--
-- The UCW path now writes `method = 'onchain-ucw'` plus the Circle challenge id
-- (for tracing), and gets its own sweep (`reconcileStaleUcwSends`) that flags
-- genuinely stuck sends for ops instead of silently losing them.
-- ============================================================================

alter table wallet_txs drop constraint if exists wallet_txs_method_check;
alter table wallet_txs add constraint wallet_txs_method_check
  check (method = any (array['qris','card','bank','onchain','cctp','internal','onchain-ucw']));

-- The stale-UCW sweep scans: type='out' + status='pending' + method='onchain-ucw'
-- + created_at < cutoff. Index keeps that cheap as the table grows.
create index if not exists wallet_txs_ucw_pending_idx
  on wallet_txs (created_at)
  where type = 'out' and status = 'pending' and method = 'onchain-ucw';
