-- ---------------------------------------------------------------------------
-- 0072 — WL deal lifecycle RPCs for the hardened escrow contract.
--
-- Companion to 0071 (which added the DISPUTED status, the deadline columns, and
-- the extended settle function). The contract now drives settlement off two
-- clocks and a dispute flag, so the DB needs matching transitions:
--
--   mark_wl_deal_delivered  — SELLER marks the goods delivered; starts the
--                             buyer's confirmation window (mirrors markDelivered).
--   flag_wl_deal_dispute    — BUYER or SELLER raises a dispute; freezes the
--                             on-chain escape hatches (mirrors flagDispute).
--   slash_wl_deal_noncustodial — Admin/MM refunds the buyer AND records that the
--                             seller's collateral was forfeited (mirrors
--                             refundEscrowWithSlash).
--
-- It also RELAXES the release/refund guards so a DISPUTED deal can still be
-- resolved by the Admin/MM. Previously both required status = 'ESCROW', which
-- would have made every disputed deal permanently unresolvable in the DB once
-- the contract froze its escape hatches — the exact deadlock 0071 set out to
-- prevent.
--
-- All functions are bookkeeping only: the CHAIN moves the money first (see
-- lib/wl/transitions.ts, "FUNDS FIRST"), these just flip status.
--
-- Idempotent (`create or replace`). Supersedes the release/refund definitions
-- in 0066.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) release_wl_deal_noncustodial — ESCROW | DISPUTED → SELESAI (Admin/MM only)
-- ---------------------------------------------------------------------------
create or replace function release_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
begin
  select d.status into v_status from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  -- DISPUTED is accepted so a disputed deal can still be resolved in the
  -- seller's favour once the middleman has arbitrated.
  if v_status not in ('ESCROW', 'DISPUTED') then
    raise exception 'release: status must be ESCROW or DISPUTED (got %)', v_status;
  end if;
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'release: Admin/MM only';
  end if;

  -- NO ledger_post, NO wallet credit — the on-chain relay pays the seller.
  update wl_deals set status = 'SELESAI', updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 2) refund_wl_deal_noncustodial — ESCROW | DISPUTED → BATAL (Admin/MM only)
--    On-chain: refundEscrow returns price to the buyer, collateral to the seller.
-- ---------------------------------------------------------------------------
create or replace function refund_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
begin
  select d.status into v_status from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status not in ('ESCROW', 'DISPUTED') then
    raise exception 'refund: status must be ESCROW or DISPUTED (got %)', v_status;
  end if;
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'refund: Admin/MM only';
  end if;

  -- NO ledger_post, NO wallet credit — the on-chain relay refunds the buyer.
  update wl_deals set status = 'BATAL', updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 3) slash_wl_deal_noncustodial — ESCROW | DISPUTED → BATAL + collateral forfeited
--
--    On-chain this pairs with refundEscrowWithSlash: the buyer receives
--    price + collateral as compensation for proven fraud. The DB records the
--    forfeited amount in `collateral_slashed` so the seller's original deposit
--    stays auditable next to what was taken from them.
-- ---------------------------------------------------------------------------
create or replace function slash_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
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
     set status = 'BATAL',
         collateral_slashed = coalesce(v_collateral, 0),
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 4) mark_wl_deal_delivered — SELLER marks delivered (ESCROW → ESCROW)
--
--    Starts the buyer's confirmation clock. Mirrors the contract's
--    markDelivered, which sets confirmDeadline = now + CONFIRM_WINDOW (7 days).
--    No status change: the deal stays ESCROW until it is released or refunded.
-- ---------------------------------------------------------------------------
create or replace function mark_wl_deal_delivered(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
  v_seller_id uuid;
  v_delivered_at timestamptz;
begin
  select d.status, d.seller_id, d.delivered_at
    into v_status, v_seller_id, v_delivered_at
    from wl_deals d
   where d.id = p_deal_id
     for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'mark delivered: status must be ESCROW (got %)', v_status;
  end if;
  if v_seller_id is distinct from p_actor_id then
    raise exception 'mark delivered: seller only';
  end if;
  if v_delivered_at is not null then
    raise exception 'mark delivered: already delivered';
  end if;

  update wl_deals
     set delivered_at = now(),
         confirm_deadline = now() + interval '7 days',
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 5) flag_wl_deal_dispute — BUYER or SELLER raises a dispute (ESCROW → DISPUTED)
--
--    Freezes the on-chain escape hatches while the middleman arbitrates. If the
--    platform never resolves, the contract's DISPUTE_BACKSTOP (30 days) refunds
--    the buyer — so a dispute can never lock funds forever.
-- ---------------------------------------------------------------------------
create or replace function flag_wl_deal_dispute(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
  v_buyer_id uuid;
  v_seller_id uuid;
  v_disputed_at timestamptz;
begin
  select d.status, d.buyer_id, d.seller_id, d.disputed_at
    into v_status, v_buyer_id, v_seller_id, v_disputed_at
    from wl_deals d
   where d.id = p_deal_id
     for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'dispute: status must be ESCROW (got %)', v_status;
  end if;
  if p_actor_id is distinct from v_buyer_id and p_actor_id is distinct from v_seller_id then
    raise exception 'dispute: buyer or seller only';
  end if;
  if v_disputed_at is not null then
    raise exception 'dispute: already disputed';
  end if;

  update wl_deals
     set status = 'DISPUTED',
         disputed_at = now(),
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 6) Audit actions for the new lifecycle events
--
--    The escrow lifecycle now has three transitions that are not release/refund,
--    and mm_audit_log's CHECK constraint rejects unknown actions (so an
--    unlisted event would dead-letter the audit row). Extend the allowlist.
-- ---------------------------------------------------------------------------
alter table public.mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table public.mm_audit_log add constraint mm_audit_log_action_check
  CHECK (action IN (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','COLLECT_FEES',
    'MM_PROMOTE','MM_DEMOTE','REVOKE_SELLER','BAN_USER','UNBAN_USER',
    'FREEZE_PRODUCT','UNFREEZE_PRODUCT','FREEZE_STORE','UNFREEZE_STORE',
    'ALLOWANCE_DANGLING','RECONCILE_DRIFT','WALLET_FREEZE','WALLET_UNFREEZE',
    'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK',
    'CANCEL_WL_DEAL','MM_PIN_SET',
    -- added by 0072
    'WL_DEAL_DELIVERED','WL_DEAL_DISPUTED','SLASH_COLLATERAL'
  ));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function release_wl_deal_noncustodial(uuid, uuid) to service_role;
grant execute on function refund_wl_deal_noncustodial(uuid, uuid) to service_role;
grant execute on function slash_wl_deal_noncustodial(uuid, uuid) to service_role;
grant execute on function mark_wl_deal_delivered(uuid, uuid) to service_role;
grant execute on function flag_wl_deal_dispute(uuid, uuid) to service_role;

grant execute on function release_wl_deal_noncustodial(uuid, uuid) to postgres;
grant execute on function refund_wl_deal_noncustodial(uuid, uuid) to postgres;
grant execute on function slash_wl_deal_noncustodial(uuid, uuid) to postgres;
grant execute on function mark_wl_deal_delivered(uuid, uuid) to postgres;
grant execute on function flag_wl_deal_dispute(uuid, uuid) to postgres;
