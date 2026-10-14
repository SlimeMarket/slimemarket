-- ============================================================================
-- SlimeMarket — 0017: Add 'internal' method to wallet_txs for treasury payouts/airdrops.
-- ============================================================================

ALTER TABLE wallet_txs DROP CONSTRAINT IF EXISTS wallet_txs_method_check;
ALTER TABLE wallet_txs ADD CONSTRAINT wallet_txs_method_check
  CHECK (method = ANY (ARRAY['qris','card','bank','onchain','cctp','internal']));
