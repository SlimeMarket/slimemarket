-- ---------------------------------------------------------------------------
-- 0070 — allow the permissionless 7-day escape hatch to settle a WL deal that
--        is FUNDED ON-CHAIN but still MENUNGGU.
--
-- WHY THIS IS NEEDED
-- ------------------
-- In non-custodial mode (`ONCHAIN_WALLET_FUNDS=1`) `confirmWlDeal` relays
-- `createEscrowDealFor`, so the buyer's `price + 2%` leaves their wallet
-- ON-CHAIN — but the DB status only advances to ESCROW when the SELLER proceeds.
--
-- If the seller never proceeds, the buyer had NO way out:
--   * `cancel` is refused for on-chain deals (cancelling would strand the funds
--     with no refund path) — see app/api/wl/deals/[id]/cancel/route.ts;
--   * `release` / `refund` both require status ESCROW;
--   * the escape hatch (this function) required ESCROW as well.
-- Result: the buyer's USDC was unrecoverable through the app.
--
-- The 7-day guard is NOT weakened: the route computes elapsed time from the
-- CONTRACT's own `deals(id).createdAt`, not from this row, and the contract
-- itself re-checks `block.timestamp > createdAt + ESCROW_TIMEOUT` before paying
-- out. This function performs bookkeeping only — no ledger or wallet movement —
-- because the chain has already moved the money.
--
-- Idempotent (`create or replace`). Supersedes the definition in 0066.
-- ---------------------------------------------------------------------------

create or replace function settle_wl_deal_after_timeout(p_deal_id uuid, p_decision text)
returns void as $$
declare
  v_status text;
  v_on_chain_deal_id text;
begin
  select d.status, d.on_chain_deal_id
    into v_status, v_on_chain_deal_id
    from wl_deals d
   where d.id = p_deal_id
     for update;
  if v_status is null then raise exception 'deal not found'; end if;

  -- ESCROW is the normal case. MENUNGGU is accepted ONLY when the deal was
  -- actually funded on-chain. "0" IS a valid contract deal id (the first deal),
  -- so test for null/empty rather than falsiness.
  if v_status <> 'ESCROW' then
    if not (v_status = 'MENUNGGU' and coalesce(v_on_chain_deal_id, '') <> '') then
      raise exception
        'settle: status must be ESCROW, or MENUNGGU with an on-chain deal id (got %)',
        v_status;
    end if;
  end if;

  if p_decision not in ('release','refund') then
    raise exception 'settle: decision must be release or refund (got %)', p_decision;
  end if;

  update wl_deals
     set status = case when p_decision = 'release' then 'SELESAI' else 'BATAL' end,
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

grant execute on function settle_wl_deal_after_timeout(uuid, text) to service_role;
grant execute on function settle_wl_deal_after_timeout(uuid, text) to postgres;
