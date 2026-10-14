-- 0082 — let the BUYER release a non-custodial WL deal
--
-- BUG: the contract allows the buyer to settle their own deal —
--
--   contracts/MarketEscrow.sol:534
--     function confirmEscrow(uint256 dealId) external {
--       require(msg.sender == d.buyer, "!buyer");
--       ...
--       _releaseEscrow(d, dealId);   // pays the seller, returns the collateral
--     }
--
-- and the app wires the buyer's "Confirm receipt" button straight at it
-- (public/app.jsx `confirmReceiptDeal` → action `confirmEscrow` →
-- POST /api/wl/deals/[id]/confirm-receipt → `confirmDealAsBuyer`).
--
-- But `confirmDealAsBuyer` calls `release_wl_deal_noncustodial`, which only
-- accepted Admin/MM:
--
--   if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM'))
--     then raise exception 'release: Admin/MM only';
--
-- So the on-chain confirmEscrow SUCCEEDED while the DB write was rejected with
-- "release: Admin/MM only" — the contract released the funds but the deal stayed
-- ESCROW forever, and the buyer saw an error for an action that had worked.
--
-- Fix: accept the deal's own buyer, mirroring the contract. Admin/MM keep their
-- arbitration path (including resolving a DISPUTED deal).

create or replace function release_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
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
  update wl_deals set status = 'SELESAI', updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- Functions default to EXECUTE for PUBLIC in Postgres; a SECURITY DEFINER
-- function left open would be callable by anon through PostgREST.
revoke all on function release_wl_deal_noncustodial(uuid, uuid) from anon, authenticated, public;

comment on function release_wl_deal_noncustodial(uuid, uuid) is
  'ESCROW|DISPUTED → SELESAI for a non-custodial WL deal. Callable by the deal''s buyer (mirrors confirmEscrow) or Admin/MM (arbitration, mirrors releaseEscrow).';
