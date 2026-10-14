-- ============================================================================
-- SlimeMarket — 0025_auto_release_ledger: Fix auto-release to settle ledger
-- ============================================================================
-- P1-3/NEW-3 FIX: The original auto_release_expired_orders (0014) only updated
-- order status to DONE but did NOT create ledger entries or credit the seller's
-- wallet. This caused seller money to disappear on auto-release.
--
-- This migration replaces the function with one that mirrors confirm_order_atomic:
--   - Posts ledger: DR escrow_holding, CR seller_payout (98%), CR platform_fee (2%),
--     CR gas_pool (circle+gas)
--   - Credits seller wallet balance
--   - Bumps buyer tx_count (role promotion)
--   - Returns released orders for on-chain mirroring
-- ============================================================================

create or replace function auto_release_expired_orders()
returns setof orders as $$
declare
  v_order record;
  v_locked     bigint;
  v_platform_fee bigint;
  v_seller_payout bigint;
  v_seller_wallet uuid;
  v_group_id   uuid;
begin
  for v_order in
    select * from orders
     where status = 'SENT'
       and release_deadline is not null
       and release_deadline < now()
     for update of orders
  loop
    -- Calculate amounts (same as confirm_order_atomic)
    v_locked := v_order.amount + v_order.circle_fee + v_order.gas_fee;
    v_platform_fee := (v_order.amount * 200) / 10000;  -- 2%
    v_seller_payout := v_order.amount - v_platform_fee; -- 98%

    -- Resolve seller wallet via store owner
    select w.id into v_seller_wallet
      from wallets w join stores s on s.owner_user_id = w.user_id
     where s.id = v_order.store_id;

    if v_seller_wallet is null then
      -- Cannot settle without seller wallet — skip this order (will retry next run)
      continue;
    end if;

    -- Ledger release: DR escrow (full locked), CR seller_payout (98%),
    -- CR platform_fee (2%), CR gas_pool (circle+gas)
    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_locked,'ref_id',v_order.id::text),
      jsonb_build_object('account','seller_payout','direction','CR','amount',v_seller_payout,'wallet_id',v_seller_wallet,'ref_id',v_order.id::text),
      jsonb_build_object('account','platform_fee','direction','CR','amount',v_platform_fee,'ref_id',v_order.id::text),
      jsonb_build_object('account','gas_pool','direction','CR','amount',(v_order.circle_fee + v_order.gas_fee),'ref_id',v_order.id::text)
    ));

    -- Credit seller wallet
    update wallets set usdc_balance = usdc_balance + v_seller_payout where id = v_seller_wallet;

    -- Flip status, bump buyer tx_count
    update orders set status = 'DONE', updated_at = now() where id = v_order.id;
    update users set tx_count = tx_count + 1 where id = v_order.buyer_id;

    -- Return the released order (for on-chain mirroring in TS)
    return next v_order;
  end loop;
end;
$$ language plpgsql security definer;
