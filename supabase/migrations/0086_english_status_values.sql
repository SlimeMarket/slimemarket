-- 0086 — rename WL deal status values to English
--
--   MENUNGGU -> WAITING
--   SELESAI  -> COMPLETED
--   BATAL    -> CANCELLED
--
-- (ESCROW and DISPUTED were already English.)
--
-- WHY: the status enum is a cross-layer contract (DB CHECK <-> RPC <-> TS <-> UI)
-- and the Indonesian values leaked into the public codebase. The UI already
-- mapped them to English labels via STATUS_META, so nothing user-visible changes
-- here — this is about the code and the schema speaking one language.
--
-- The function bodies below are NOT hand-written: they were dumped from the LIVE
-- database (`pg_get_functiondef`) and only the three literals were substituted,
-- so they are byte-for-byte the deployed logic. Doing it by hand would have been
-- the easiest way to silently drop a branch.
--
-- ORDER MATTERS: drop the CHECK -> rewrite the rows -> re-add the CHECK -> replace
-- the functions. If the constraint is re-added before the data is rewritten, the
-- UPDATE fails; if the functions are replaced before the constraint, they can
-- write values the old CHECK rejects.

begin;

-- 1) the CHECK must go before the data can be rewritten
alter table wl_deals drop constraint if exists wl_deals_status_check;

-- 2) migrate existing rows
update wl_deals set status = 'WAITING'   where status = 'MENUNGGU';
update wl_deals set status = 'COMPLETED' where status = 'SELESAI';
update wl_deals set status = 'CANCELLED' where status = 'BATAL';

-- 3) re-add the CHECK with the English vocabulary
alter table wl_deals add constraint wl_deals_status_check
  check (status = any (array['WAITING', 'ESCROW', 'DISPUTED', 'COMPLETED', 'CANCELLED']));

-- 3b) the COLUMN DEFAULT still says 'MENUNGGU'. Easy to miss because it lives in
--     the column definition, not the constraint — but a row inserted without an
--     explicit status would now violate the new CHECK and the INSERT would fail.
alter table wl_deals alter column status set default 'WAITING';

-- 4) re-create every function that referenced the old literals

CREATE OR REPLACE FUNCTION public.create_wl_deal(p_buyer_id uuid, p_listing_id uuid, p_unit bigint, p_qty integer, p_is_offer boolean, p_base_fee bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_id            uuid := gen_random_uuid();
  v_owner_id      uuid;
  v_side          text;
  v_buyer_id      uuid;
  v_seller_id     uuid;
  v_price         bigint;
  v_total         bigint;
  v_needs_coll    boolean;
begin
  select seller_id, side, collateral
    into v_owner_id, v_side, v_needs_coll
    from wl_listings where id = p_listing_id;
  if v_owner_id is null then raise exception 'listing not found'; end if;

  -- Default to WTS for rows created before the column existed.
  if v_side is null then v_side := 'WTS'; end if;

  if v_side = 'WTB' then
    -- The listing owner wants to BUY; the responder is the seller.
    v_buyer_id  := v_owner_id;
    v_seller_id := p_buyer_id;   -- param name kept for compatibility
    if v_buyer_id = v_seller_id then raise exception 'cannot respond to own listing'; end if;
  else
    v_buyer_id  := p_buyer_id;
    v_seller_id := v_owner_id;
    if v_seller_id = v_buyer_id then raise exception 'cannot buy own listing'; end if;
  end if;

  v_price := p_unit * p_qty;
  v_total := v_price + p_base_fee;

  insert into wl_deals (id, listing_id, buyer_id, seller_id, unit, qty, price,
    base_fee, total, is_offer, needs_collateral, seller_collateral, buyer_held,
    middleman_joined, status)
  values (v_id, p_listing_id, v_buyer_id, v_seller_id, p_unit, p_qty, v_price,
    p_base_fee, v_total, p_is_offer, v_needs_coll, 0, false, false, 'WAITING');

  return v_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.proceed_wl_deal_atomic(p_deal_id uuid, p_actor_id uuid, p_circle_fee bigint, p_gas_fee bigint, p_collateral bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  if v_status <> 'WAITING' then raise exception 'proceed: status must be WAITING (got %)', v_status; end if;
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
$function$
;
CREATE OR REPLACE FUNCTION public.proceed_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_status text;
  v_seller_id uuid;
  v_window integer;
begin
  select d.status, d.seller_id into v_status, v_seller_id
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'WAITING' then
    raise exception 'proceed: status must be WAITING (got %)', v_status;
  end if;
  if p_actor_id <> v_seller_id then raise exception 'proceed: seller only'; end if;
  if coalesce(p_collateral, 0) < 0 then raise exception 'proceed: negative collateral'; end if;

  -- The seller's delivery window, as advertised on the listing before the buyer
  -- paid. Fall back to the 7-day default if the listing row is somehow missing.
  select l.delivery_window_seconds into v_window
    from wl_deals d join wl_listings l on l.id = d.listing_id
   where d.id = p_deal_id;
  if v_window is null or v_window <= 0 then v_window := 604800; end if;

  -- NO ledger_post, NO wallet debit/credit: funds live in MarketEscrow.
  -- delivery_deadline is set here ONLY when still null — confirmWlDeal already
  -- anchored it at funding to match the contract's own clock.
  update wl_deals
     set status = 'ESCROW',
         seller_collateral = coalesce(p_collateral, 0),
         delivery_deadline = coalesce(delivery_deadline, now() + make_interval(secs => v_window)),
         updated_at = now()
   where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.proceed_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid, p_collateral bigint DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_status text;
  v_seller_id uuid;
begin
  select d.status, d.seller_id into v_status, v_seller_id
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'WAITING' then
    raise exception 'proceed: status must be WAITING (got %)', v_status;
  end if;
  if p_actor_id <> v_seller_id then raise exception 'proceed: seller only'; end if;
  if coalesce(p_collateral, 0) < 0 then raise exception 'proceed: negative collateral'; end if;

  -- NO ledger_post, NO wallet debit/credit: funds live in MarketEscrow.
  update wl_deals
     set status = 'ESCROW',
         seller_collateral = coalesce(p_collateral, 0),
         updated_at = now()
   where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refund_wl_deal_atomic(p_deal_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  update wl_deals set status = 'CANCELLED' where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refund_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_status text;
begin
  select d.status into v_status from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'refund: status must be ESCROW (got %)', v_status;
  end if;
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'refund: Admin/MM only';
  end if;

  -- NO ledger_post, NO wallet credit — the on-chain relay refunds the buyer.
  update wl_deals set status = 'CANCELLED', updated_at = now() where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.release_wl_deal_atomic(p_deal_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  update wl_deals set status = 'COMPLETED' where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.release_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_status text;
  v_buyer_id uuid;
begin
  select d.status, d.buyer_id into v_status, v_buyer_id
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;

  -- DISPUTED is accepted so a disputed deal can still be resolved in the
  -- seller's favour once the middleman has arbitrated.
  if v_status not in ('ESCROW', 'DISPUTED') then
    raise exception 'release: status must be ESCROW or DISPUTED (got %)', v_status;
  end if;

  -- Either the buyer settling their own deal (contract: confirmEscrow), or
  -- Admin/MM arbitrating (contract: releaseEscrow).
  if not (
    p_actor_id = v_buyer_id
    or exists (select 1 from users where id = p_actor_id and role in ('Admin','MM'))
  ) then
    raise exception 'release: buyer or Admin/MM only';
  end if;

  -- NO ledger_post, NO wallet credit — the on-chain relay pays the seller.
  update wl_deals set status = 'COMPLETED', updated_at = now() where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.settle_wl_deal_after_timeout(p_deal_id uuid, p_decision text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_status text;
begin
  select d.status into v_status from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'settle: status must be ESCROW (got %)', v_status;
  end if;
  if p_decision not in ('release','refund') then
    raise exception 'settle: decision must be release or refund (got %)', p_decision;
  end if;

  update wl_deals
     set status = case when p_decision = 'release' then 'COMPLETED' else 'CANCELLED' end,
         updated_at = now()
   where id = p_deal_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.slash_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_status text;
  v_collateral bigint;
begin
  select d.status, d.seller_collateral
    into v_status, v_collateral
    from wl_deals d
   where d.id = p_deal_id
     for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status not in ('ESCROW', 'DISPUTED') then
    raise exception 'slash: status must be ESCROW or DISPUTED (got %)', v_status;
  end if;
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'slash: Admin/MM only';
  end if;

  update wl_deals
     set status = 'CANCELLED',
         collateral_slashed = coalesce(v_collateral, 0),
         updated_at = now()
   where id = p_deal_id;
end;
$function$
;

-- 5) CREATE OR REPLACE resets privileges to the default, which grants EXECUTE to
--    PUBLIC — i.e. anon could call these through PostgREST again (bug #20 class).
--    Re-lock every function we just touched.
revoke all on function create_wl_deal(uuid, uuid, bigint, integer, boolean, bigint) from anon, authenticated, public;
revoke all on function proceed_wl_deal_atomic(uuid, uuid, bigint, bigint, bigint) from anon, authenticated, public;
revoke all on function proceed_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;
revoke all on function proceed_wl_deal_noncustodial(uuid, uuid, bigint) from anon, authenticated, public;
revoke all on function refund_wl_deal_atomic(uuid, uuid) from anon, authenticated, public;
revoke all on function refund_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;
revoke all on function release_wl_deal_atomic(uuid, uuid) from anon, authenticated, public;
revoke all on function release_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;
revoke all on function settle_wl_deal_after_timeout(uuid, text) from anon, authenticated, public;
revoke all on function slash_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;

commit;
