-- ============================================================================
-- SlimeMarket — 0027: On-chain escrow indexer state + tracking columns.
--
-- Part of the non-custodial escrow migration (see docs/ONCHAIN_ESCROW_PLAN.md §9).
-- The indexer (lib/contracts/indexer.ts) watches MarketEscrow events and mirrors
-- lifecycle transitions into the DB. This migration adds:
--   1. indexer_state — a tiny KV to persist the last processed block (resume).
--   2. on-chain tracking columns on orders / wl_deals for idempotent updates.
-- ============================================================================

-- 1. Indexer resume state (single logical stream keyed by contract address).
create table if not exists indexer_state (
  id                  text primary key,          -- e.g. 'market_escrow'
  contract_address    text not null,
  last_processed_block bigint not null default 0,
  updated_at          timestamptz not null default now()
);

-- 2. Order on-chain tracking (on_chain_order_id already added in 0014).
alter table orders
  add column if not exists on_chain_tx_hash text,       -- createOrderFor tx hash
  add column if not exists on_chain_status  text;        -- CREATED | RELEASED | REFUNDED

-- 3. WL deal on-chain tracking (on_chain_deal_id already added in 0020).
alter table wl_deals
  add column if not exists on_chain_tx_hash text,
  add column if not exists on_chain_status  text;

-- Lookups by contract id (indexer maps event.id → row).
create index if not exists idx_orders_on_chain_order_id on orders (on_chain_order_id);
create index if not exists idx_wl_deals_on_chain_deal_id on wl_deals (on_chain_deal_id);
