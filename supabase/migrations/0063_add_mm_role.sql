-- ============================================================================
-- 3 — MM (middleman) becomes a real, admin-manageable role.
--
--   1) users.role CHECK widened to admit 'MM' (auto-named inline constraint
--      `users_role_check` from 0001_init.sql line 20 — never redefined since;
--      0035 only touched the unrelated chat_messages_sender_role_check).
--   2) release_wl_deal_atomic / refund_wl_deal_atomic role gate widened from
--      `role = 'Admin'` to `role in ('Admin','MM')` so the DB enforces the
--      same authorization as the app layer (requireStaffAuth in
--      lib/admin-auth.ts). Bodies are copies of 0009_wl_m4.sql with ONLY the
--      role gate + error text changed.
--   3) releaseDeal/refundDeal EXECUTION keeps relaying through the platform
--      DCW wallet (PLATFORM_CIRCLE_WALLET_ID) — MM is a DB authorization role
--      only; nothing about the on-chain path changes here.
-- ============================================================================

-- 1) users.role: admit 'MM'
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('Member','Buyer','Seller','MM','Admin'));

-- 2a) release_wl_deal_atomic — ESCROW→SELESAI. Admin/MM only.
--   Seller gets FULL item price (0% platform fee). Collateral returned FULL.
--   Circle+gas+base = gas_pool (platform revenue).
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
  -- admin/MM check (Phase 3 — middleman role may release)
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'release: Admin/MM only';
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

-- 2b) refund_wl_deal_atomic — ESCROW→BATAL. Admin/MM only.
--   Buyer refund full locked. Collateral returned to seller.
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
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'refund: Admin/MM only';
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
