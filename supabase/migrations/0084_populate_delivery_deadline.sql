-- 0084 — actually populate `delivery_deadline` (it was declared but never written)
--
-- Migration 0071 added the column and described it as "the seller must mark
-- delivered before this ... Mirrors the contract's `deliveryDeadline`", and added
-- an index "because the settlement sweeper scans for deals whose deadline has
-- passed". But NOTHING ever wrote it — the only references anywhere were the
-- column declaration, the index, and the read path in lib/wl/mappers.ts.
--
-- Consequences (all silent):
--   • `deliveryPassed` in public/escrow.jsx is `deal.deliveryDeadline ? … : false`,
--     so it was ALWAYS false → the "Force Refund" escape hatch never rendered,
--     even for a deal the seller never delivered. The deadline-based refund path
--     was unreachable from the UI.
--   • The deal room shows "Seller delivers by the deadline above" with no
--     deadline.
--   • The partial index had nothing to select, so the sweeper scanned nothing.
--
-- The contract sets the deadline when the deal is created; the DB mirrors it here
-- when the deal reaches ESCROW, using the per-listing window the seller chose
-- (wl_listings.delivery_window_seconds, default 7 days).

create or replace function proceed_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
  v_seller_id uuid;
  v_window integer;
begin
  select d.status, d.seller_id into v_status, v_seller_id
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'MENUNGGU' then
    raise exception 'proceed: status must be MENUNGGU (got %)', v_status;
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
  update wl_deals
     set status = 'ESCROW',
         seller_collateral = coalesce(p_collateral, 0),
         delivery_deadline = now() + make_interval(secs => v_window),
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- Functions default to EXECUTE for PUBLIC; a SECURITY DEFINER left open would be
-- callable by anon through PostgREST.
revoke all on function proceed_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;

comment on function proceed_wl_deal_noncustodial(uuid, uuid) is
  'MENUNGGU → ESCROW for a non-custodial WL deal. Sets delivery_deadline from the listing''s delivery_window_seconds so the deadline-based refund path is reachable.';
