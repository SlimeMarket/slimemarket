-- ============================================================================
-- Custodial ledger: rewrite the order RPCs to the 2% + 2% model.
--
-- WHY: the custodial (SQL-ledger) path and the on-chain MarketEscrow contract
-- had drifted into two DIFFERENT fee models, which made every fee question a
-- research project:
--
--   * contract (v4, non-custodial, the live path):
--       buyer pays amount + 2%, seller receives 100%  → platform 2%
--   * custodial RPCs (0007 / 0025 / 0053):
--       buyer paid amount + 2% into escrow, then release credited the seller
--       98% and platform_fee 2% — i.e. the buyer fee was ALSO the platform fee,
--       and the 2% the buyer paid at creation was never credited to
--       platform_fee. Escrow_holding therefore accumulated a 2% surplus that
--       nothing ever released (a real accounting leak).
--
-- The model is now ONE model, matching the new contract:
--
--   MARKETPLACE
--     buyer pays        amount + 2%   (FEE_BPS, non-refundable, at creation)
--     seller receives   amount - 2%   (SELLER_FEE_BPS, at release) = 98%
--     platform receives 2% + 2%       = 4% of the item amount
--
--   Ledger at creation:  DR user_wallet (amount + buyer_fee)
--                        CR escrow_holding (amount)
--                        CR platform_fee (buyer_fee)
--   Ledger at release:   DR escrow_holding (amount)
--                        CR seller_payout (amount - seller_fee)
--                        CR platform_fee (seller_fee)
--   Ledger at refund:    DR escrow_holding (amount)
--                        CR user_wallet (amount)
--                        (buyer_fee stays in platform_fee — non-refundable)
--
-- NOTE ON PARAMETER NAMES: `create_order_atomic`'s 6th argument used to be
-- `p_circle_fee`, repurposed by the TypeScript caller to carry the buyer fee.
-- Postgres cannot rename an input parameter via CREATE OR REPLACE, so the
-- function is dropped and recreated with the honest name `p_buyer_fee`.
-- `p_gas_fee` is kept for arity compatibility and ignored (always 0).
--
-- These RPCs only run when ONCHAIN_WALLET_FUNDS != 1. In non-custodial mode the
-- `*_noncustodial` variants (0048 / 0061 / 0066) are used and move no ledger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_order_atomic — buyer debit + escrow funding.
-- ---------------------------------------------------------------------------
drop function if exists create_order_atomic(
  uuid, uuid, uuid, text, int, text, text, text, text, text[], jsonb, boolean
);

create function create_order_atomic(
  p_buyer_id    uuid,
  p_store_id    uuid,
  p_product_id  uuid,
  p_variant     text,
  p_qty         int,
  p_buyer_fee   text,      -- buyer-side platform fee (2% of item), micro-USDC
  p_gas_fee     text,      -- legacy, ignored (always 0)
  p_payment     text,
  p_delivery    text,
  p_terms       text[],
  p_credentials jsonb,
  p_instant     boolean
) returns uuid as $$
declare
  v_oid           uuid := gen_random_uuid();
  v_buyer_wallet  uuid;
  v_product_price bigint;
  v_item_amount   bigint;
  v_buyer_fee     bigint := coalesce(nullif(p_buyer_fee,'')::bigint, 0);
  v_total_debit   bigint;
  v_buyer_bal     bigint;
  v_pop_result    jsonb;
  v_creds         jsonb := p_credentials;
  v_status        text := 'PENDING';
  v_group_id      uuid;
begin
  -- resolve buyer wallet
  select id into v_buyer_wallet from wallets where user_id = p_buyer_id;
  if v_buyer_wallet is null then raise exception 'create_order: buyer wallet not found'; end if;

  -- get product price (single price — variants handled in app layer)
  select price into v_product_price from products where id = p_product_id for update;
  if v_product_price is null then raise exception 'create_order: product not found'; end if;

  v_item_amount := v_product_price * p_qty;
  v_total_debit := v_item_amount + v_buyer_fee;

  -- lock buyer wallet, check available balance
  select usdc_balance into v_buyer_bal from wallets where id = v_buyer_wallet for update;
  if wallet_available_balance(v_buyer_wallet) < v_total_debit then
    raise exception 'insufficient balance for checkout (need %)', v_total_debit;
  end if;

  -- instant: pop stock FIFO atomically
  if p_instant then
    select pop_stock_fifo(p_product_id, p_qty) into v_pop_result;
    if v_pop_result ? 'items' then
      select v_pop_result->'items' into v_creds;
    end if;
    v_status := 'SENT';
  end if;

  -- insert order row. buyer_fee is its own column (0041); circle_fee/gas_fee are
  -- legacy and stay 0 so the fee is not double-counted anywhere.
  insert into orders (id, buyer_id, store_id, product_id, variant, qty, amount,
    buyer_fee, circle_fee, gas_fee, payment, delivery, status, terms)
  values (v_oid, p_buyer_id, p_store_id, p_product_id, p_variant, p_qty, v_item_amount,
    v_buyer_fee, 0, 0, p_payment, p_delivery, v_status, p_terms);

  -- ledger: buyer pays item + fee; escrow holds the ITEM only, the buyer fee is
  -- platform revenue from the moment it is collected.
  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','user_wallet','direction','DR','amount',v_total_debit,'wallet_id',v_buyer_wallet,'ref_id',v_oid::text),
    jsonb_build_object('account','escrow_holding','direction','CR','amount',v_item_amount,'ref_id',v_oid::text),
    jsonb_build_object('account','platform_fee','direction','CR','amount',v_buyer_fee,'ref_id',v_oid::text)
  ));

  -- decrement buyer balance
  update wallets set usdc_balance = usdc_balance - v_total_debit where id = v_buyer_wallet;

  if v_creds is not null and v_creds <> '{}'::jsonb then
    update orders set credentials_vault_ref = v_creds::text where id = v_oid;
  end if;

  return v_oid;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- confirm_order_atomic — SENT → DONE (buyer confirms). Release to seller with
-- the 2% SELLER fee deducted; escrow holds only the item amount.
-- ---------------------------------------------------------------------------
create or replace function confirm_order_atomic(p_order_id uuid, p_actor_id uuid)
returns bigint as $$
declare
  v_status text; v_buyer_id uuid; v_store_id uuid;
  v_amount bigint;
  v_seller_fee bigint; v_seller_payout bigint;
  v_seller_wallet uuid; v_group_id uuid;
begin
  select status, buyer_id, store_id, amount
    into v_status, v_buyer_id, v_store_id, v_amount
    from orders where id = p_order_id for update;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status <> 'SENT' then raise exception 'confirm: status must be SENT (got %)', v_status; end if;
  if p_actor_id <> v_buyer_id then raise exception 'confirm: not buyer'; end if;

  v_seller_fee := (v_amount * 200) / 10000;      -- 2%
  v_seller_payout := v_amount - v_seller_fee;    -- 98%

  select w.id into v_seller_wallet
    from wallets w join stores s on s.owner_user_id = w.user_id
   where s.id = v_store_id;
  if v_seller_wallet is null then raise exception 'confirm: seller wallet not found'; end if;

  -- escrow releases exactly what it holds (the item amount); the seller fee
  -- becomes platform revenue, the rest goes to the seller.
  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','escrow_holding','direction','DR','amount',v_amount,'ref_id',p_order_id::text),
    jsonb_build_object('account','seller_payout','direction','CR','amount',v_seller_payout,'wallet_id',v_seller_wallet,'ref_id',p_order_id::text),
    jsonb_build_object('account','platform_fee','direction','CR','amount',v_seller_fee,'ref_id',p_order_id::text)
  ));

  update wallets set usdc_balance = usdc_balance + v_seller_payout where id = v_seller_wallet;

  update orders set status = 'DONE' where id = p_order_id;
  update users set tx_count = tx_count + 1 where id = v_buyer_id;

  return v_seller_payout;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- auto_release_expired_orders — same release math as confirm_order_atomic.
-- ---------------------------------------------------------------------------
create or replace function auto_release_expired_orders()
returns setof orders as $$
declare
  v_order record;
  v_seller_fee bigint;
  v_seller_payout bigint;
  v_seller_wallet uuid;
  v_group_id uuid;
begin
  for v_order in
    select * from orders
     where status = 'SENT'
       and release_deadline is not null
       and release_deadline < now()
     for update of orders
  loop
    v_seller_fee := (v_order.amount * 200) / 10000;     -- 2%
    v_seller_payout := v_order.amount - v_seller_fee;   -- 98%

    select w.id into v_seller_wallet
      from wallets w join stores s on s.owner_user_id = w.user_id
     where s.id = v_order.store_id;

    if v_seller_wallet is null then
      -- Cannot settle without a seller wallet — skip (retried next run).
      continue;
    end if;

    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_order.amount,'ref_id',v_order.id::text),
      jsonb_build_object('account','seller_payout','direction','CR','amount',v_seller_payout,'wallet_id',v_seller_wallet,'ref_id',v_order.id::text),
      jsonb_build_object('account','platform_fee','direction','CR','amount',v_seller_fee,'ref_id',v_order.id::text)
    ));

    update wallets set usdc_balance = usdc_balance + v_seller_payout where id = v_seller_wallet;

    update orders set status = 'DONE', updated_at = now() where id = v_order.id;
    update users set tx_count = tx_count + 1 where id = v_order.buyer_id;

    return next v_order;
  end loop;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- resolve_dispute_atomic — admin decision on a DISPUTED order.
-- refund: buyer gets the item back (buyer fee stays with the platform).
-- release: seller gets item - 2%; platform gets that 2%.
-- ---------------------------------------------------------------------------
create or replace function resolve_dispute_atomic(p_order_id uuid, p_actor_id uuid, p_decision text, p_reason text)
returns void as $$
declare
  v_status text; v_buyer_id uuid; v_amount bigint;
  v_buyer_wallet uuid; v_seller_wallet uuid;
  v_store_id uuid; v_group_id uuid;
  v_seller_fee bigint; v_seller_payout bigint;
begin
  select status, buyer_id, amount, store_id
    into v_status, v_buyer_id, v_amount, v_store_id
    from orders where id = p_order_id for update;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status <> 'DISPUTED' then raise exception 'resolve: order must be DISPUTED (got %)', v_status; end if;
  if not exists (select 1 from users where id = p_actor_id and role = 'Admin') then
    raise exception 'resolve: Admin only';
  end if;

  select id into v_buyer_wallet from wallets where user_id = v_buyer_id;

  if p_decision = 'refund' then
    -- Buyer is made whole on the item; the 2% buyer fee is non-refundable and
    -- was already credited to platform_fee at creation.
    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_amount,'ref_id',p_order_id::text),
      jsonb_build_object('account','user_wallet','direction','CR','amount',v_amount,'wallet_id',v_buyer_wallet,'ref_id',p_order_id::text)
    ));
    update wallets set usdc_balance = usdc_balance + v_amount where id = v_buyer_wallet;
    update orders set status = 'CANCELLED', cancel_reason = p_reason, updated_at = now() where id = p_order_id;

  elsif p_decision = 'release' then
    select w.id into v_seller_wallet
      from wallets w join stores s on s.owner_user_id = w.user_id
     where s.id = v_store_id;
    if v_seller_wallet is null then raise exception 'resolve: seller wallet not found'; end if;

    v_seller_fee := (v_amount * 200) / 10000;     -- 2%
    v_seller_payout := v_amount - v_seller_fee;   -- 98%

    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_amount,'ref_id',p_order_id::text),
      jsonb_build_object('account','seller_payout','direction','CR','amount',v_seller_payout,'wallet_id',v_seller_wallet,'ref_id',p_order_id::text),
      jsonb_build_object('account','platform_fee','direction','CR','amount',v_seller_fee,'ref_id',p_order_id::text)
    ));
    update wallets set usdc_balance = usdc_balance + v_seller_payout where id = v_seller_wallet;
    update orders set status = 'DONE', updated_at = now() where id = p_order_id;
    update users set tx_count = tx_count + 1
      where id = (select owner_user_id from stores where id = v_store_id);
  else
    raise exception 'resolve: decision must be refund or release';
  end if;
end;
$$ language plpgsql security definer;

-- Grants mirror the originals (service_role/postgres only — these are
-- security definer functions and must never be callable by anon/authenticated).
grant execute on function create_order_atomic(uuid, uuid, uuid, text, int, text, text, text, text, text[], jsonb, boolean) to service_role;
grant execute on function create_order_atomic(uuid, uuid, uuid, text, int, text, text, text, text, text[], jsonb, boolean) to postgres;
grant execute on function confirm_order_atomic(uuid, uuid) to service_role;
grant execute on function confirm_order_atomic(uuid, uuid) to postgres;
grant execute on function auto_release_expired_orders() to service_role;
grant execute on function auto_release_expired_orders() to postgres;
grant execute on function resolve_dispute_atomic(uuid, uuid, text, text) to service_role;
grant execute on function resolve_dispute_atomic(uuid, uuid, text, text) to postgres;
