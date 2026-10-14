-- ============================================================================
-- 0032_non_custodial_order_rpc — RPC for non-custodial checkout (F2-FE Phase 3).
--
-- The legacy `create_order_atomic` (0007_order_m3.sql) debits the buyer's
-- DB `wallets.usdc_balance` and posts a ledger entry (DR user_wallet). That
-- is correct for the custodial model (DB ledger is the money source).
--
-- In non-custodial mode (ONCHAIN_WALLET_FUNDS=1), the buyer's USDC lives
-- on-chain in their UCW — the DB `usdc_balance` is a MIRROR, not spendable.
-- Debiting it would either fail (balance 0) or invent phantom spending.
--
-- This new RPC creates the order row WITHOUT debiting the DB ledger. The
-- on-chain `createOrderFor` (relayed by the DCW after the buyer approves)
-- is the real money movement. The DB order row tracks state only.
--
-- Called from `lib/order/checkout.ts:prepareCheckoutOrder` when
-- ONCHAIN_FUNDS_ENABLED=true.
-- ============================================================================

create or replace function create_non_custodial_order(
  p_buyer_id uuid,
  p_store_id uuid,
  p_product_id uuid,
  p_variant text,
  p_qty int,
  p_payment text,
  p_delivery text,
  p_terms text[]
) returns uuid as $$
declare
  v_oid           uuid := gen_random_uuid();
  v_product_price bigint;
  v_item_amount   bigint;
begin
  if p_qty < 1 then raise exception 'qty must be >= 1'; end if;

  -- get product price (lock for consistency)
  select price into v_product_price from products where id = p_product_id for update;
  if v_product_price is null then raise exception 'create_non_custodial_order: product not found'; end if;

  v_item_amount := v_product_price * p_qty;

  -- Non-custodial: NO DB balance check, NO ledger debit, NO wallet balance decrement.
  -- The on-chain approve + createOrderFor is the real money movement.
  -- DB order row tracks state only (status PENDING until on-chain confirm).
  -- circle_fee = 0, gas_fee = 0 (Phase 3.1 fee simplification).

  -- Insert order row (manual delivery — 0034 added FIFO stock pop for instant).
  insert into orders (id, buyer_id, store_id, product_id, variant, qty, amount,
    circle_fee, gas_fee, payment, delivery, status, terms)
  values (v_oid, p_buyer_id, p_store_id, p_product_id, p_variant, p_qty, v_item_amount,
    0, 0, p_payment, p_delivery, 'PENDING', p_terms);

  return v_oid;
end;
$$ language plpgsql security definer;

grant execute on function create_non_custodial_order to service_role;
grant execute on function create_non_custodial_order to postgres;
