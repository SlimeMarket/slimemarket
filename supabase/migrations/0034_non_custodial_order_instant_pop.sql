-- ============================================================================
-- 0034_non_custodial_order_instant_pop — instant delivery support for
-- non-custodial checkout.
--
-- Phase-3 fix: `create_non_custodial_order` always used status=PENDING
-- (manual delivery), even for instant products (digital goods with FIFO
-- stock). In non-custodial mode, instant products SHOULD pop stock FIFO and
-- set status=SENT immediately — the buyer already paid via on-chain approve,
-- and the seller's credentials are locked in stock. No additional seller
-- approval needed.
--
-- Also populates the `credentials_vault_ref` with the popped stock items.
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
  v_status        text := 'PENDING';
  v_pop_result    jsonb;
  v_creds         jsonb := '{}'::jsonb;
begin
  if p_qty < 1 then raise exception 'qty must be >= 1'; end if;

  -- get product price (lock for consistency)
  select price into v_product_price from products where id = p_product_id for update;
  if v_product_price is null then raise exception 'create_non_custodial_order: product not found'; end if;

  v_item_amount := v_product_price * p_qty;

  -- Non-custodial: NO DB balance check, NO ledger debit, NO wallet balance decrement.
  -- The on-chain approve + createOrderFor is the real money movement.
  -- DB order row tracks state only.
  -- circle_fee = 0, gas_fee = 0 (Phase 3.1 fee simplification).

  -- For instant delivery (digital goods with FIFO stock), pop credentials
  -- atomically and set status=SENT — no seller approval needed.
  if p_delivery = 'instant' then
    select pop_stock_fifo(p_product_id, p_qty) into v_pop_result;
    if v_pop_result ? 'items' then
      select v_pop_result->'items' into v_creds;
    end if;
    v_status := 'SENT';
  end if;

  -- Insert order row.
  insert into orders (id, buyer_id, store_id, product_id, variant, qty, amount,
    circle_fee, gas_fee, payment, delivery, status, terms)
  values (v_oid, p_buyer_id, p_store_id, p_product_id, p_variant, p_qty, v_item_amount,
    0, 0, p_payment, p_delivery, v_status, p_terms);

  -- Store popped credentials if instant.
  if v_creds <> '{}'::jsonb and v_creds is not null then
    update orders set credentials_vault_ref = v_creds::text where id = v_oid;
  end if;

  return v_oid;
end;
$$ language plpgsql security definer;

grant execute on function create_non_custodial_order to service_role;
grant execute on function create_non_custodial_order to postgres;
