-- ============================================================================
-- SlimeMarket — 0009_wl_m4: WL escrow deal RPCs (atomic, row-lock, ledger).
-- Fee FINAL (escrow mode): 0% platform seller, $4 base buyer, collateral full refund.
-- Money = bigint micro-USDC. Idempotent. Admin-only release/refund.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_wl_deal(p_buyer_id, p_listing_id, p_unit, p_qty, p_is_offer, p_base_fee)
--   Buyer quick-buy/offer → MENUNGGU. NO fund lock (buyerHeld=false).
--   Returns deal id (uuid).
-- ---------------------------------------------------------------------------
create or replace function create_wl_deal(
  p_buyer_id   uuid,
  p_listing_id uuid,
  p_unit       bigint,
  p_qty        int,
  p_is_offer   boolean,
  p_base_fee   bigint
) returns uuid as $$
declare
  v_id            uuid := gen_random_uuid();
  v_seller_id     uuid;
  v_price         bigint;
  v_total         bigint;
  v_needs_coll    boolean;
begin
  select seller_id, collateral into v_seller_id, v_needs_coll
    from wl_listings where id = p_listing_id;
  if v_seller_id is null then raise exception 'listing not found'; end if;
  if v_seller_id = p_buyer_id then raise exception 'cannot buy own listing'; end if;

  v_price := p_unit * p_qty;
  v_total := v_price + p_base_fee;

  insert into wl_deals (id, listing_id, buyer_id, seller_id, unit, qty, price,
    base_fee, total, is_offer, needs_collateral, seller_collateral, buyer_held,
    middleman_joined, status)
  values (v_id, p_listing_id, p_buyer_id, v_seller_id, p_unit, p_qty, v_price,
    p_base_fee, v_total, p_is_offer, v_needs_coll, 0, false, false, 'MENUNGGU');

  return v_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- proceed_wl_deal_atomic(p_deal_id, p_actor_id, p_circle_fee, p_gas_fee, p_collateral)
--   MENUNGGU→ESCROW. Seller sets collateral + proceed.
--   Lock buyer (price+base+circle+gas) + seller collateral. CR escrow_holding.
--   middleman_joined=true.
-- ---------------------------------------------------------------------------
create or replace function proceed_wl_deal_atomic(
  p_deal_id     uuid,
  p_actor_id    uuid,
  p_circle_fee  bigint,
  p_gas_fee     bigint,
  p_collateral  bigint
) returns void as $$
declare
  v_status text; v_buyer_id uuid; v_seller_id uuid;
  v_price bigint; v_base bigint; v_total bigint; v_locked bigint;
  v_buyer_wallet uuid; v_seller_wallet uuid;
  v_buyer_avail bigint;
  v_group_id uuid;
begin
  select status, buyer_id, seller_id, price, base_fee, total
    into v_status, v_buyer_id, v_seller_id, v_price, v_base, v_total
    from wl_deals where id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'MENUNGGU' then raise exception 'proceed: status must be MENUNGGU (got %)', v_status; end if;
  if p_actor_id <> v_seller_id then raise exception 'proceed: not seller'; end if;

  v_locked := v_total + p_circle_fee + p_gas_fee;

  -- resolve wallets
  select id into v_buyer_wallet from wallets where user_id = v_buyer_id for update;
  if v_buyer_wallet is null then raise exception 'proceed: buyer wallet not found'; end if;
  select id into v_seller_wallet from wallets where user_id = v_seller_id for update;
  if v_seller_wallet is null then raise exception 'proceed: seller wallet not found'; end if;

  -- check buyer available balance (chargeback guard)
  v_buyer_avail := wallet_available_balance(v_buyer_wallet);
  if v_buyer_avail < v_locked then raise exception 'insufficient buyer balance (need %)', v_locked; end if;

  -- check seller collateral if needed
  if p_collateral > 0 and wallet_available_balance(v_seller_wallet) < p_collateral then
    raise exception 'insufficient seller collateral (need %)', p_collateral;
  end if;

  -- ledger: DR buyer_wallet (locked), DR seller_wallet (collateral if any), CR escrow_holding
  if p_collateral > 0 then
    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','user_wallet','direction','DR','amount',v_locked,'wallet_id',v_buyer_wallet,'ref_id',p_deal_id::text),
      jsonb_build_object('account','user_wallet','direction','DR','amount',p_collateral,'wallet_id',v_seller_wallet,'ref_id',p_deal_id::text),
      jsonb_build_object('account','escrow_holding','direction','CR','amount',(v_locked + p_collateral),'ref_id',p_deal_id::text)
    ));
    update wallets set usdc_balance = usdc_balance - p_collateral where id = v_seller_wallet;
  else
    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','user_wallet','direction','DR','amount',v_locked,'wallet_id',v_buyer_wallet,'ref_id',p_deal_id::text),
      jsonb_build_object('account','escrow_holding','direction','CR','amount',v_locked,'ref_id',p_deal_id::text)
    ));
  end if;

  -- decrement buyer balance
  update wallets set usdc_balance = usdc_balance - v_locked where id = v_buyer_wallet;

  -- flip deal (total updated to include circle+gas so release can DR correctly)
  update wl_deals set status = 'ESCROW', buyer_held = true,
    seller_collateral = p_collateral, middleman_joined = true,
    total = v_locked
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- release_wl_deal_atomic(p_deal_id, p_actor_id) → ESCROW→SELESAI. Admin only.
--   Seller gets FULL item price (0% platform fee). Collateral returned FULL.
--   Circle+gas+base = gas_pool (platform revenue).
-- ---------------------------------------------------------------------------
create or replace function release_wl_deal_atomic(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text; v_buyer_id uuid; v_seller_id uuid;
  v_price bigint; v_base bigint; v_locked bigint; v_coll bigint;
  v_buyer_wallet uuid; v_seller_wallet uuid;
  v_group_id uuid;
  v_total_locked bigint;
begin
  select d.status, d.buyer_id, d.seller_id, d.price, d.base_fee, d.total, d.seller_collateral
    into v_status, v_buyer_id, v_seller_id, v_price, v_base, v_locked, v_coll
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then raise exception 'release: status must be ESCROW (got %)', v_status; end if;
  -- admin check
  if not exists (select 1 from users where id = p_actor_id and role = 'Admin') then
    raise exception 'release: Admin only';
  end if;

  select id into v_seller_wallet from wallets where user_id = v_seller_id for update;
  if v_seller_wallet is null then raise exception 'release: seller wallet not found'; end if;

  v_total_locked := v_locked + v_coll;
  -- v_locked = price + base + circle + gas (computed at proceed). circle+gas not stored
  -- separately on deal; platform revenue = base + (locked - price - base) = base + circle + gas.
  -- Seller gets price (full, 0% fee). Collateral back. Rest = gas_pool.
  declare
    v_rev bigint := v_total_locked - v_price - v_coll; -- base + circle + gas
  begin
    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_total_locked,'ref_id',p_deal_id::text),
      jsonb_build_object('account','seller_payout','direction','CR','amount',v_price,'wallet_id',v_seller_wallet,'ref_id',p_deal_id::text),
      jsonb_build_object('account','user_wallet','direction','CR','amount',v_coll,'wallet_id',v_seller_wallet,'ref_id',p_deal_id::text),
      jsonb_build_object('account','gas_pool','direction','CR','amount',v_rev,'ref_id',p_deal_id::text)
    ));
  end;

  -- credit seller: price + collateral
  update wallets set usdc_balance = usdc_balance + v_price + v_coll where id = v_seller_wallet;
  update wl_deals set status = 'SELESAI' where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- refund_wl_deal_atomic(p_deal_id, p_actor_id) → ESCROW→BATAL. Admin only.
--   Buyer refund full locked. Collateral returned to seller.
-- ---------------------------------------------------------------------------
create or replace function refund_wl_deal_atomic(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text; v_buyer_id uuid; v_seller_id uuid;
  v_locked bigint; v_coll bigint;
  v_buyer_wallet uuid; v_seller_wallet uuid;
  v_total_locked bigint; v_group_id uuid;
begin
  select d.status, d.buyer_id, d.seller_id, d.total, d.seller_collateral
    into v_status, v_buyer_id, v_seller_id, v_locked, v_coll
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then raise exception 'refund: status must be ESCROW (got %)', v_status; end if;
  if not exists (select 1 from users where id = p_actor_id and role = 'Admin') then
    raise exception 'refund: Admin only';
  end if;

  select id into v_buyer_wallet from wallets where user_id = v_buyer_id for update;
  if v_buyer_wallet is null then raise exception 'refund: buyer wallet not found'; end if;
  v_total_locked := v_locked + v_coll;

  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','escrow_holding','direction','DR','amount',v_total_locked,'ref_id',p_deal_id::text),
    jsonb_build_object('account','user_wallet','direction','CR','amount',v_locked,'wallet_id',v_buyer_wallet,'ref_id',p_deal_id::text),
    jsonb_build_object('account','user_wallet','direction','CR','amount',v_coll,'ref_id',p_deal_id::text)
  ));

  -- refund buyer (locked) + collateral back to seller (if any)
  update wallets set usdc_balance = usdc_balance + v_locked where id = v_buyer_wallet;
  if v_coll > 0 then
    select id into v_seller_wallet from wallets where user_id = v_seller_id for update;
    if v_seller_wallet is not null then
      update wallets set usdc_balance = usdc_balance + v_coll where id = v_seller_wallet;
    end if;
  end if;
  update wl_deals set status = 'BATAL' where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- Seed an Admin user for testing release/refund (login: admin@mvp.local / Admin123!)
-- ---------------------------------------------------------------------------
do $$
declare v_auth uuid;
begin
  -- create auth user if missing
  if not exists (select 1 from auth.users where email = 'admin@mvp.local') then
    -- create via auth schema directly (dev only)
    insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, role, aud, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (
      gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
      'admin@mvp.local', crypt('Admin123!', gen_salt('bf')),
      now(), 'authenticated', 'authenticated',
      '{"provider":"email","providers":["email"]}', '{}', now(), now()
    ) returning id into v_auth;
  else
    select id into v_auth from auth.users where email = 'admin@mvp.local';
  end if;

  -- ensure profile row
  if not exists (select 1 from users where auth_id = v_auth) then
    insert into users (auth_id, uid, name, handle, email, role, tx_count, kyc, avatar_gradient, referral_code, preferred_lang)
    values (v_auth, 'ADMINTEST', 'Admin Test', '@admintest', 'admin@mvp.local', 'Admin', 0, 'verified', 'from-rose-500 to-orange-600', 'ADM-TEST', 'en');
  else
    update users set role = 'Admin' where auth_id = v_auth;
  end if;

  -- ensure wallet
  if not exists (select 1 from wallets w join users u on u.id = w.user_id where u.auth_id = v_auth) then
    insert into wallets (user_id, address, circle_wallet_id, usdc_balance)
    select u.id, '0x6F7a8b9C0d1e2f3a4B5c6d7e8f9a0B1c2d3E4f5a', 'cwallet-admintest', 0
    from users u where u.auth_id = v_auth;
  end if;
end$$;
