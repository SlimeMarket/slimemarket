-- ============================================================================
-- SlimeMarket — 0020: Add on_chain_deal_id to wl_deals for contract escrow tracking.
-- ============================================================================

ALTER TABLE wl_deals ADD COLUMN IF NOT EXISTS on_chain_deal_id text;
