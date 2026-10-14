-- ============================================================================
-- — WL (rekber) escrow: NON-CUSTODIAL RPC variants.
--
-- BUG THIS FIXES (found by the audit): in non-custodial mode
-- (ONCHAIN_WALLET_FUNDS=1) the WL flow still called the CUSTODIAL RPCs
-- (proceed_wl_deal_atomic / release_wl_deal_atomic / refund_wl_deal_atomic),
-- which debit/credit wallets.usdc_balance and post ledger entries — while the
-- real money was already moving on-chain via MarketEscrow (createEscrowDealFor
-- pulls price+fee from the buyer; releaseEscrow pays the seller). Result:
-- phantom internal balances the platform does not hold (users could withdraw
-- USDC from the platform DCW that never arrived) and, worse,
-- proceed_wl_deal_atomic reverts with "insufficient buyer balance" when the
-- buyer's internal balance is empty — so non-custodial WL deals could not
-- proceed AT ALL.
--
-- Same bug class 0048/0061 fixed for marketplace orders. These variants keep
-- every guard (status, actor, FOR UPDATE row lock) and the status flip, but
-- perform NO ledger_post and NO wallets.usdc_balance change. Money movement is
-- the on-chain relay's job alone in non-custodial mode.
--
-- Callers (lib/wl/transitions.ts) select the variant based on
-- ONCHAIN_FUNDS_ENABLED, mirroring lib/order/refund.ts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) proceed_wl_deal_noncustodial — MENUNGGU → ESCROW (seller only)
--    On-chain: the seller's collateral was already deposited via
--    depositEscrowCollateral and the buyer funds the deal via
--    createEscrowDealFor. This RPC only records the state transition.
-- ---------------------------------------------------------------------------
create or replace function proceed_wl_deal_noncustodial(
  p_deal_id  uuid,
  p_actor_id uuid,
  p_collateral bigint default 0
)
returns void as $$
declare
  v_status text;
  v_seller_id uuid;
begin
  select d.status, d.seller_id into v_status, v_seller_id
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'MENUNGGU' then
    raise exception 'proceed: status must be MENUNGGU (got %)', v_status;
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
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 2) release_wl_deal_noncustodial — ESCROW → SELESAI (Admin/MM only)
--    On-chain: releaseEscrow pays the seller price + returns collateral.
-- ---------------------------------------------------------------------------
create or replace function release_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
begin
  select d.status into v_status from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'release: status must be ESCROW (got %)', v_status;
  end if;
  if not exists (select 1 from users where id = p_actor_id and role in ('Admin','MM')) then
    raise exception 'release: Admin/MM only';
  end if;

  -- NO ledger_post, NO wallet credit — the on-chain relay pays the seller.
  update wl_deals set status = 'SELESAI', updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- 3) refund_wl_deal_noncustodial — ESCROW → BATAL (Admin/MM only)
--    On-chain: refundEscrow returns price to the buyer, collateral to the seller.
-- ---------------------------------------------------------------------------
create or replace function refund_wl_deal_noncustodial(p_deal_id uuid, p_actor_id uuid)
returns void as $$
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
  update wl_deals set status = 'BATAL', updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

grant execute on function proceed_wl_deal_noncustodial(uuid, uuid, bigint) to service_role;
grant execute on function release_wl_deal_noncustodial(uuid, uuid) to service_role;
grant execute on function refund_wl_deal_noncustodial(uuid, uuid) to service_role;
grant execute on function proceed_wl_deal_noncustodial(uuid, uuid, bigint) to postgres;
grant execute on function release_wl_deal_noncustodial(uuid, uuid) to postgres;
grant execute on function refund_wl_deal_noncustodial(uuid, uuid) to postgres;

-- ---------------------------------------------------------------------------
-- 4) settle_wl_deal_after_timeout — permissionless settlement bookkeeping.
--
-- The contract lets ANYONE call releaseEscrowAfterTimeout/refundEscrowAfterTimeout
-- once ESCROW_TIMEOUT (7 days) has elapsed (anti-censorship escape hatch). The
-- staff-gated *_wl_deal_noncustodial RPCs above cannot be used for that path
-- (the caller is an ordinary user, not Admin/MM), so this variant mirrors the
-- on-chain rule instead: status must be ESCROW and the actor is anyone. It
-- still performs NO ledger/wallet movement — the chain already moved.
-- ---------------------------------------------------------------------------
create or replace function settle_wl_deal_after_timeout(p_deal_id uuid, p_decision text)
returns void as $$
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
     set status = case when p_decision = 'release' then 'SELESAI' else 'BATAL' end,
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

grant execute on function settle_wl_deal_after_timeout(uuid, text) to service_role;
grant execute on function settle_wl_deal_after_timeout(uuid, text) to postgres;

-- ---------------------------------------------------------------------------
-- 5) Audit: allow the pre-escrow WL cancel event through mm_audit_log's CHECK
-- (0021/0065 list). Adding only — existing allowed actions are preserved.
-- ---------------------------------------------------------------------------
alter table public.mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table public.mm_audit_log add constraint mm_audit_log_action_check
  check (action in (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','MM_PROMOTE','MM_DEMOTE',
    'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK',
    'CANCEL_WL_DEAL'
  ));
