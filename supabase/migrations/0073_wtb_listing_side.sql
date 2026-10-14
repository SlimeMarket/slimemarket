-- ---------------------------------------------------------------------------
-- 0073 — A1: Want-To-Buy (WTB) listings.
--
-- Today a listing is always a SELL offer: the owner has something to sell and a
-- visitor buys it. OTC groups on Telegram work both ways — people post
-- "cari 1000 USDC @ 16.400" (WTB) just as often as "jual 1000 USDC @ 16.500"
-- (WTS). Without WTB, half the order flow has nowhere to land, which is the
-- single biggest liquidity problem for a new marketplace.
--
-- Design: ONE table, one new column. A WTB listing is the same row with the
-- direction flipped — the owner is the BUYER and whoever responds is the SELLER.
-- `create_wl_deal` is the only place that has to know, because it is what turns
-- a listing + a responder into a deal with concrete buyer/seller ids.
--
-- `wl_listings.seller_id` keeps its name (renaming would touch a lot of code and
-- break existing rows) but now means "the user who created the listing". The
-- direction column is what tells you which side that user is on.
-- ---------------------------------------------------------------------------

alter table public.wl_listings
  add column if not exists side text not null default 'WTS';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wl_listings_side_check'
  ) then
    alter table public.wl_listings
      add constraint wl_listings_side_check check (side in ('WTS', 'WTB'));
  end if;
end $$;

comment on column public.wl_listings.side is
  'WTS = the owner sells (responder buys). WTB = the owner buys (responder sells).';

create index if not exists wl_listings_side_idx on public.wl_listings (side);

-- ---------------------------------------------------------------------------
-- create_wl_deal — direction-aware.
--
-- WTS: caller = buyer, listing owner = seller   (unchanged behaviour)
-- WTB: caller = seller, listing owner = buyer   (flipped)
--
-- The "cannot trade with yourself" guard stays, but its message now reflects
-- which side the caller is on so the error is not confusing on a WTB listing.
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
    p_base_fee, v_total, p_is_offer, v_needs_coll, 0, false, false, 'MENUNGGU');

  return v_id;
end;
$$ language plpgsql security definer;

grant execute on function create_wl_deal(uuid, uuid, bigint, int, boolean, bigint) to service_role;
grant execute on function create_wl_deal(uuid, uuid, bigint, int, boolean, bigint) to postgres;
