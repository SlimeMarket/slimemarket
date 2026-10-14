-- ---------------------------------------------------------------------------
-- 0071 — Escrow / OTC settlement hardening (matches MarketEscrow.sol rewrite).
--
-- WHY THIS IS NEEDED
-- ------------------
-- The contract previously settled every deal off ONE clock (`ESCROW_TIMEOUT`,
-- hardcoded 7 days) and BOTH escape hatches opened at the same instant with the
-- same condition. Whoever called first won — settlement was non-deterministic.
-- Two other gaps made long-running OTC deals unsafe:
--
--   * the seller's collateral ALWAYS returned to the seller, so it protected
--     nobody — a seller could take the buyer's money, never deliver, and still
--     get the deposit back;
--   * there was no per-deal freeze, so raising a dispute did not stop the
--     timeout from paying the seller out from under it.
--
-- The contract now uses TWO clocks (deliveryDeadline → confirmDeadline) with
-- mutually exclusive escape hatches, a per-deal dispute flag, and a
-- `refundEscrowWithSlash` path that forfeits the collateral to the buyer.
--
-- This migration brings the DB in line:
--   1. a DISPUTED deal status;
--   2. deadline / dispute / slash bookkeeping columns;
--   3. `settle_wl_deal_after_timeout` extended to record a slashed settlement.
--
-- Idempotent. Supersedes the `settle_wl_deal_after_timeout` definition in 0070.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Deal status — add DISPUTED
-- ---------------------------------------------------------------------------
-- The original CHECK was declared inline on the column, so Postgres named it
-- `wl_deals_status_check`. Drop by name (guarded) and re-add with DISPUTED.
alter table wl_deals drop constraint if exists wl_deals_status_check;
alter table wl_deals add constraint wl_deals_status_check
  check (status in ('MENUNGGU','ESCROW','DISPUTED','SELESAI','BATAL'));

-- ---------------------------------------------------------------------------
-- 2. Deadline / dispute / slash bookkeeping
-- ---------------------------------------------------------------------------
-- `delivery_deadline` — the seller must mark delivered before this. Past it, the
--   buyer's refund path opens. Mirrors the contract's `deliveryDeadline`.
-- `confirm_deadline` — set when the seller marks delivered. Past it with the
--   buyer silent, the release path opens. Mirrors `confirmDeadline`.
-- `disputed_at` — when a party raised the dispute; the contract's backstop is
--   measured from here.
-- `collateral_slashed` — how much of the seller's collateral was forfeited to
--   the buyer as fraud compensation. Kept separate from `seller_collateral` so
--   the original deposit remains auditable.
alter table wl_deals add column if not exists delivery_deadline timestamptz;
alter table wl_deals add column if not exists confirm_deadline  timestamptz;
alter table wl_deals add column if not exists delivered_at     timestamptz;
alter table wl_deals add column if not exists disputed_at      timestamptz;
alter table wl_deals add column if not exists collateral_slashed bigint not null default 0;

-- ---------------------------------------------------------------------------
-- 2b. Per-listing delivery window (the seller chooses how long they get)
-- ---------------------------------------------------------------------------
-- The timeout is a property of the LISTING, not a global constant: a WL spot is
-- delivered in minutes, while an airdrop-eligible wallet may only pay out months
-- later. The seller sets it; the buyer sees it BEFORE paying. The contract clamps
-- the value into [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW], so an out-of-range
-- row can never make a deal unsolvable — it is only the UI default that is stored.
alter table wl_listings add column if not exists delivery_window_seconds integer not null default 604800;
alter table wl_listings drop constraint if exists wl_listings_delivery_window_check;
alter table wl_listings add constraint wl_listings_delivery_window_check
  check (delivery_window_seconds > 0);

-- The settlement sweeper scans for deals whose deadline has passed, so index
-- the deadlines. Partial indexes keep them small: only unresolved deals matter.
create index if not exists wl_deals_delivery_deadline_idx
  on wl_deals (delivery_deadline)
  where status in ('MENUNGGU','ESCROW');

create index if not exists wl_deals_confirm_deadline_idx
  on wl_deals (confirm_deadline)
  where status = 'ESCROW';

create index if not exists wl_deals_disputed_idx
  on wl_deals (disputed_at)
  where status = 'DISPUTED';

-- ---------------------------------------------------------------------------
-- 3. Settlement bookkeeping function
-- ---------------------------------------------------------------------------
-- Bookkeeping only — the CHAIN has already moved the money before this runs.
-- Accepts the extra `slash` decision so a fraud ruling can be recorded: the deal
-- closes as BATAL (the buyer was refunded) with `collateral_slashed` set.
--
-- DISPUTED is now a valid starting state: the middleman resolves a disputed deal
-- through the same entry point.
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

  -- ESCROW and DISPUTED are the normal cases. MENUNGGU is accepted ONLY when the
  -- deal was actually funded on-chain. "0" IS a valid contract deal id (the
  -- first deal), so test for null/empty rather than falsiness.
  if v_status not in ('ESCROW', 'DISPUTED') then
    if not (v_status = 'MENUNGGU' and coalesce(v_on_chain_deal_id, '') <> '') then
      raise exception
        'settle: status must be ESCROW or DISPUTED, or MENUNGGU with an on-chain deal id (got %)',
        v_status;
    end if;
  end if;

  if p_decision not in ('release','refund','slash') then
    raise exception 'settle: decision must be release, refund or slash (got %)', p_decision;
  end if;

  -- `release` → SELESAI (seller paid). `refund` and `slash` both leave the buyer
  -- with their money back, so both close as BATAL; `slash` additionally records
  -- that the seller's collateral was forfeited to the buyer.
  update wl_deals
     set status = case when p_decision = 'release' then 'SELESAI' else 'BATAL' end,
         collateral_slashed = case
           when p_decision = 'slash' then seller_collateral
           else collateral_slashed
         end,
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

grant execute on function settle_wl_deal_after_timeout(uuid, text) to service_role;
grant execute on function settle_wl_deal_after_timeout(uuid, text) to postgres;
