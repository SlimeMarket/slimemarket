-- ============================================================================
-- 0036_onchain_retry — Add retry tracking for failed on-chain release/refund.
--
-- Problem: when on-chain release/refund fails, DB already says "DONE/CANCELLED"
-- but USDC is still locked in the contract. on_chain_status stays null (looks
-- like "never tried"). No retry mechanism exists.
--
-- Fix: add columns to track retry state + widen CHECK to include *_failed.
-- ============================================================================

-- orders: retry tracking
ALTER TABLE orders ADD COLUMN IF NOT EXISTS on_chain_retry_count int NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS on_chain_last_attempt_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS on_chain_circle_tx_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS on_chain_error text;

-- wl_deals: retry tracking
ALTER TABLE wl_deals ADD COLUMN IF NOT EXISTS on_chain_retry_count int NOT NULL DEFAULT 0;
ALTER TABLE wl_deals ADD COLUMN IF NOT EXISTS on_chain_last_attempt_at timestamptz;
ALTER TABLE wl_deals ADD COLUMN IF NOT EXISTS on_chain_circle_tx_id text;
ALTER TABLE wl_deals ADD COLUMN IF NOT EXISTS on_chain_error text;

-- Widen on_chain_status CHECK to include failed states
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_on_chain_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_on_chain_status_check
  CHECK (on_chain_status IS NULL OR on_chain_status IN (
    'CREATED','release_pending','refund_pending','RELEASED','REFUNDED',
    'release_failed','refund_failed'
  ));

ALTER TABLE wl_deals DROP CONSTRAINT IF EXISTS wl_deals_on_chain_status_check;
ALTER TABLE wl_deals ADD CONSTRAINT wl_deals_on_chain_status_check
  CHECK (on_chain_status IS NULL OR on_chain_status IN (
    'CREATED','release_pending','refund_pending','RELEASED','REFUNDED',
    'release_failed','refund_failed'
  ));

-- Index for the reconcile cron: find failed/pending on-chain releases
CREATE INDEX IF NOT EXISTS idx_orders_on_chain_retry
  ON orders(on_chain_status)
  WHERE on_chain_status IN ('release_pending','refund_pending','release_failed','refund_failed');

CREATE INDEX IF NOT EXISTS idx_wl_deals_on_chain_retry
  ON wl_deals(on_chain_status)
  WHERE on_chain_status IN ('release_pending','refund_pending','release_failed','refund_failed');
