-- 0085 — anchor the DB `delivery_deadline` at FUNDING, not at proceed (bug #35)
--
-- 0084 populated `delivery_deadline` inside `proceed_wl_deal_noncustodial`
-- (MENUNGGU → ESCROW), i.e. when the SELLER accepts. But the contract sets its
-- `deliveryDeadline = block.timestamp + deliveryWindow` at FUNDING time
-- (`_createEscrowDeal` / `createEscrowDealFor`), which for the non-custodial
-- flow happens in `confirmWlDeal` — strictly EARLIER than proceed.
--
-- Consequence: the DB deadline was always a few seconds/minutes LATER than the
-- chain's. The escape-hatch guard trusted the DB value, so once the DB clock
-- elapsed but the contract's had not, the route relayed a tx the contract then
-- reverted ("delivery deadline not passed").
--
-- `confirmWlDeal` now writes `delivery_deadline` at funding (matching the
-- contract). This function keeps its write ONLY as a fallback for rows that
-- still have no deadline (legacy deals confirmed before that change, or a
-- confirm whose chain write did not land) — `coalesce` guarantees it never
-- overwrites the accurate funding-anchored value.

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
  -- delivery_deadline is set here ONLY when still null — confirmWlDeal already
  -- anchored it at funding to match the contract's own clock.
  update wl_deals
     set status = 'ESCROW',
         seller_collateral = coalesce(p_collateral, 0),
         delivery_deadline = coalesce(delivery_deadline, now() + make_interval(secs => v_window)),
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- Functions default to EXECUTE for PUBLIC; a SECURITY DEFINER left open would be
-- callable by anon through PostgREST.
revoke all on function proceed_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;

comment on function proceed_wl_deal_noncustodial(uuid, uuid) is
  'MENUNGGU → ESCROW for a non-custodial WL deal. Fills delivery_deadline from the listing''s delivery_window_seconds ONLY when still null (confirmWlDeal already anchors it at funding, matching the contract).';
