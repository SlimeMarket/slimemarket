-- ============================================================================
-- 0051_wl_eoa_payer — WL deals: EOA external-wallet payer logging (.D3)
-- ============================================================================
-- Mirrors migration 0050's orders payer columns for WL escrow deals:
--   (a) buyer_payer_address      — wallet that funded the deal (permit/approve)
--   (b) buyer_payer_wallet_type  — 'ucw' | 'eoa' | 'platform'
--   (c) seller_collateral_tx_hash — seller's own depositEscrowCollateral tx
--       (set when the seller deposits from their EOA via WalletBridge; the
--       UCW PIN challenge path does not expose a tx hash)
--   (d) seller_collateral_wallet_type — 'ucw' | 'eoa' | 'platform'
--
-- Fully idempotent: IF NOT EXISTS + catalog-guarded constraint re-add.
-- ============================================================================

-- (a) buyer payer tracking
alter table wl_deals add column if not exists buyer_payer_address text;
alter table wl_deals add column if not exists buyer_payer_wallet_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wl_deals_buyer_payer_wallet_type_check'
  ) then
    alter table wl_deals add constraint wl_deals_buyer_payer_wallet_type_check
      check (buyer_payer_wallet_type in ('ucw','eoa','platform'));
  end if;
end $$;

-- (c) seller collateral EOA deposit tx hash
alter table wl_deals add column if not exists seller_collateral_tx_hash text;

-- (d) seller collateral wallet type (who deposited: UCW challenge / EOA / platform)
alter table wl_deals add column if not exists seller_collateral_wallet_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wl_deals_seller_collateral_wallet_type_check'
  ) then
    alter table wl_deals add constraint wl_deals_seller_collateral_wallet_type_check
      check (seller_collateral_wallet_type in ('ucw','eoa','platform'));
  end if;
end $$;
