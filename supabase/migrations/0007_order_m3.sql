-- ============================================================================
-- SlimeMarket — 0007_order_m3: order lifecycle RPCs (atomic, row-lock, ledger).
-- Money = bigint micro-USDC. Fee FINAL: 2% platform at DONE (seller), circle+gas buyer.
-- Idempotent (status-guarded). All financial mutations go through ledger_post.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_order_atomic(p_buyer_id, p_store_id, p_product_id, p_variant, p_qty,
--                     p_circle_fee, p_gas_fee, p_payment, p_delivery, p_terms,
--                     p_credentials jsonb, p_instant boolean)
--   Checkout. Debits buyer wallet (item + circle + gas), credits escrow_holding.
--   Instant: pop_stock_fifo (atomic), status SENT, credentials stored.
--   Manual:  status PENDING, empty credentials.
--   Returns: order uuid.
-- ---------------------------------------------------------------------------
create or replace function create_order_atomic(
  p_buyer_id    uuid,
  p_store_id    uuid,
  p_product_id  uuid,
  p_variant     text,
  p_qty         int,
  p_circle_fee  text,
  p_gas_fee     text,
  p_payment     text,
  p_delivery    text,
  p_terms       text[],
  p_credentials jsonb,
  p_instant     boolean
) returns uuid as $$
declare
  v_oid           uuid := gen_random_uuid();
  v_pid           text := 'SLM-' || upper(substr(encode(gen_random_bytes(5),'hex'),1,8));
  v_buyer_wallet  uuid;
  v_product_price bigint;
  v_item_amount   bigint;
  v_circle        bigint := p_circle_fee::bigint;
  v_gas           bigint := p_gas_fee::bigint;
  v_total_debit   bigint;
  v_buyer_bal     bigint;
  v_pop_result    jsonb;
  v_creds         jsonb := p_credentials;
  v_status        text := 'PENDING';
  v_group_id      uuid;
  v_group_id2     uuid;
begin
  -- resolve buyer wallet
  select id into v_buyer_wallet from wallets where user_id = p_buyer_id;
  if v_buyer_wallet is null then raise exception 'create_order: buyer wallet not found'; end if;

  -- get product price (single price — variants handled in app layer)
  select price into v_product_price from products where id = p_product_id for update;
  if v_product_price is null then raise exception 'create_order: product not found'; end if;

  v_item_amount := v_product_price * p_qty;
  v_total_debit := v_item_amount + v_circle + v_gas;

  -- lock buyer wallet, check available balance
  select usdc_balance into v_buyer_bal from wallets where id = v_buyer_wallet for update;
  if wallet_available_balance(v_buyer_wallet) < v_total_debit then
    raise exception 'insufficient balance for checkout (need %)', v_total_debit;
  end if;

  -- instant: pop stock FIFO atomically
  if p_instant then
    select pop_stock_fifo(p_product_id, p_qty) into v_pop_result;
    -- pop returns {items, remaining, status}; store items as credentials
    if v_pop_result ? 'items' then
      select v_pop_result->'items' into v_creds;
    end if;
    v_status := 'SENT';
  end if;

  -- insert order row
  insert into orders (id, buyer_id, store_id, product_id, variant, qty, amount,
    circle_fee, gas_fee, payment, delivery, status, terms)
  values (v_oid, p_buyer_id, p_store_id, p_product_id, p_variant, p_qty, v_item_amount,
    v_circle, v_gas, p_payment, p_delivery, v_status, p_terms);

  -- ledger: debit buyer (DR user_wallet), credit escrow (CR escrow_holding)
  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','user_wallet','direction','DR','amount',v_total_debit,'wallet_id',v_buyer_wallet,'ref_id',v_oid::text),
    jsonb_build_object('account','escrow_holding','direction','CR','amount',v_total_debit,'ref_id',v_oid::text)
  ));

  -- decrement buyer balance
  update wallets set usdc_balance = usdc_balance - v_total_debit where id = v_buyer_wallet;

  -- store credentials in a new column (M3 plaintext; M7 → vault)
  if v_creds is not null and v_creds <> '{}'::jsonb then
    update orders set credentials_vault_ref = v_creds::text where id = v_oid;
  end if;

  return v_oid;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- advance_order(p_order_id, p_actor_id) → PENDING→PROCESS. Seller only.
-- ---------------------------------------------------------------------------
create or replace function advance_order(p_order_id uuid, p_actor_id uuid)
returns void as $$
declare v_status text; v_store_owner uuid;
begin
  select o.status, s.owner_user_id into v_status, v_store_owner
    from orders o join stores s on s.id = o.store_id
   where o.id = p_order_id for update of o;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status <> 'PENDING' then raise exception 'advance: status must be PENDING (got %)', v_status; end if;
  if p_actor_id <> v_store_owner then raise exception 'advance: not store owner'; end if;
  update orders set status = 'PROCESS' where id = p_order_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- send_order(p_order_id, p_actor_id, p_credentials jsonb, p_notes text)
--   PROCESS→SENT. Seller fills credentials. Stores plaintext (M3), vault M7.
-- ---------------------------------------------------------------------------
create or replace function send_order(
  p_order_id uuid, p_actor_id uuid, p_credentials jsonb, p_notes text
) returns void as $$
declare v_status text; v_store_owner uuid;
begin
  select o.status, s.owner_user_id into v_status, v_store_owner
    from orders o join stores s on s.id = o.store_id
   where o.id = p_order_id for update of o;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status <> 'PROCESS' then raise exception 'send: status must be PROCESS (got %)', v_status; end if;
  if p_actor_id <> v_store_owner then raise exception 'send: not store owner'; end if;
  update orders set status = 'SENT', credentials_vault_ref = p_credentials::text where id = p_order_id;
  -- M7: write p_notes to terms or a notes column
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- confirm_order_atomic(p_order_id, p_actor_id) → SENT→DONE. Buyer only.
-- Release: DR escrow_holding (full locked), CR seller_payout (98%), CR platform_fee (2%).
-- Bumps buyer tx_count (role promotion at 3).
-- Returns seller payout amount (micro).
-- ---------------------------------------------------------------------------
create or replace function confirm_order_atomic(p_order_id uuid, p_actor_id uuid)
returns bigint as $$
declare
  v_status text; v_buyer_id uuid; v_store_id uuid;
  v_amount bigint; v_circle bigint; v_gas bigint; v_locked bigint;
  v_platform_fee bigint; v_seller_payout bigint;
  v_seller_wallet uuid; v_group_id uuid;
begin
  select status, buyer_id, store_id, amount, circle_fee, gas_fee
    into v_status, v_buyer_id, v_store_id, v_amount, v_circle, v_gas
    from orders where id = p_order_id for update;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status <> 'SENT' then raise exception 'confirm: status must be SENT (got %)', v_status; end if;
  if p_actor_id <> v_buyer_id then raise exception 'confirm: not buyer'; end if;

  v_locked := v_amount + v_circle + v_gas;
  v_platform_fee := (v_amount * 200) / 10000;  -- 2%
  v_seller_payout := v_amount - v_platform_fee; -- 98%

  -- resolve seller wallet via store owner
  select w.id into v_seller_wallet
    from wallets w join stores s on s.owner_user_id = w.user_id
   where s.id = v_store_id;
  if v_seller_wallet is null then raise exception 'confirm: seller wallet not found'; end if;

  -- ledger release: DR escrow (full locked incl fees), CR seller_payout (98% item),
  -- CR platform_fee (2% item), CR gas_pool (circle+gas — platform revenue).
  -- ΣDR = ΣCR (v_locked = v_seller_payout + v_platform_fee + v_circle + v_gas).
  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','escrow_holding','direction','DR','amount',v_locked,'ref_id',p_order_id::text),
    jsonb_build_object('account','seller_payout','direction','CR','amount',v_seller_payout,'wallet_id',v_seller_wallet,'ref_id',p_order_id::text),
    jsonb_build_object('account','platform_fee','direction','CR','amount',v_platform_fee,'ref_id',p_order_id::text),
    jsonb_build_object('account','gas_pool','direction','CR','amount',(v_circle + v_gas),'ref_id',p_order_id::text)
  ));

  -- credit seller wallet
  update wallets set usdc_balance = usdc_balance + v_seller_payout where id = v_seller_wallet;

  -- flip status, bump buyer tx_count
  update orders set status = 'DONE' where id = p_order_id;
  update users set tx_count = tx_count + 1 where id = v_buyer_id;

  return v_seller_payout;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- cancel_order_atomic(p_order_id, p_actor_id, p_reason) → CANCELLED. Buyer, PENDING/PROCESS.
-- Refund buyer full locked amount.
-- ---------------------------------------------------------------------------
create or replace function cancel_order_atomic(p_order_id uuid, p_actor_id uuid, p_reason text)
returns void as $$
declare
  v_status text; v_buyer_id uuid; v_amount bigint; v_circle bigint; v_gas bigint;
  v_locked bigint; v_buyer_wallet uuid; v_group_id uuid;
begin
  select status, buyer_id, amount, circle_fee, gas_fee
    into v_status, v_buyer_id, v_amount, v_circle, v_gas
    from orders where id = p_order_id for update;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status not in ('PENDING','PROCESS') then raise exception 'cancel: only PENDING/PROCESS (got %)', v_status; end if;
  if p_actor_id <> v_buyer_id then raise exception 'cancel: not buyer'; end if;

  v_locked := v_amount + v_circle + v_gas;
  select id into v_buyer_wallet from wallets where user_id = v_buyer_id;

  -- refund: DR escrow, CR buyer
  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','escrow_holding','direction','DR','amount',v_locked,'ref_id',p_order_id::text),
    jsonb_build_object('account','user_wallet','direction','CR','amount',v_locked,'wallet_id',v_buyer_wallet,'ref_id',p_order_id::text)
  ));
  update wallets set usdc_balance = usdc_balance + v_locked where id = v_buyer_wallet;
  update orders set status = 'CANCELLED', cancel_reason = p_reason where id = p_order_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- decline_order_atomic(p_order_id, p_actor_id, p_reason) → DECLINED. Seller, PENDING/PROCESS.
-- Refund buyer full.
-- ---------------------------------------------------------------------------
create or replace function decline_order_atomic(p_order_id uuid, p_actor_id uuid, p_reason text)
returns void as $$
declare
  v_status text; v_buyer_id uuid; v_store_owner uuid; v_amount bigint; v_circle bigint; v_gas bigint;
  v_locked bigint; v_buyer_wallet uuid; v_group_id uuid;
begin
  select o.status, o.buyer_id, s.owner_user_id, o.amount, o.circle_fee, o.gas_fee
    into v_status, v_buyer_id, v_store_owner, v_amount, v_circle, v_gas
    from orders o join stores s on s.id = o.store_id
   where o.id = p_order_id for update of o;
  if v_status is null then raise exception 'order not found'; end if;
  if v_status not in ('PENDING','PROCESS') then raise exception 'decline: only PENDING/PROCESS (got %)', v_status; end if;
  if p_actor_id <> v_store_owner then raise exception 'decline: not store owner'; end if;

  v_locked := v_amount + v_circle + v_gas;
  select id into v_buyer_wallet from wallets where user_id = v_buyer_id;

  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','escrow_holding','direction','DR','amount',v_locked,'ref_id',p_order_id::text),
    jsonb_build_object('account','user_wallet','direction','CR','amount',v_locked,'wallet_id',v_buyer_wallet,'ref_id',p_order_id::text)
  ));
  update wallets set usdc_balance = usdc_balance + v_locked where id = v_buyer_wallet;
  update orders set status = 'DECLINED', decline_reason = p_reason where id = p_order_id;
end;
$$ language plpgsql security definer;
