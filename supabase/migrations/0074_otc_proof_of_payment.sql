-- ---------------------------------------------------------------------------
-- 0074 — D3: proof-of-payment for the fiat leg of an OTC deal.
--
-- The `orders` status machine (PENDING→PROCESS→SENT→DONE) is shaped around
-- shipping physical goods. OTC does not work that way: the buyer sends money to
-- the seller's bank OUTSIDE the platform, and the only thing the platform can
-- witness is each side SAYING it happened. Without that record a fiat deal is
-- indistinguishable from one where the buyer never paid.
--
-- The flow this enables:
--   buyer marks "I sent the payment"   → payment_marked_at
--   seller confirms "I received it"    → payment_confirmed_at
--   seller may then mark delivered     (gated below)
--
-- Why gate `mark_wl_deal_delivered` on it: in a fiat OTC deal the seller's whole
-- reason for delivering is that the money arrived. Letting them mark delivered
-- first invites a "delivered but never paid" dispute with nothing on record.
-- The gate is skipped entirely when the deal has no fiat leg, so ordinary
-- USDC-for-goods deals are unaffected.
--
-- Both timestamps are one-way. Once the buyer says they paid, or the seller says
-- they received, that statement is a fact on the record — re-clicking must not
-- move the timestamp or let either side quietly retract.
-- ---------------------------------------------------------------------------

alter table public.wl_deals
  add column if not exists fiat_leg boolean not null default false,
  add column if not exists payment_marked_at timestamptz,
  add column if not exists payment_confirmed_at timestamptz;

comment on column public.wl_deals.fiat_leg is
  'True when the buyer pays the seller in fiat outside the platform (e.g. IDR bank transfer).';
comment on column public.wl_deals.payment_marked_at is
  'When the BUYER declared they sent the off-platform payment.';
comment on column public.wl_deals.payment_confirmed_at is
  'When the SELLER confirmed the off-platform payment arrived.';

-- ---------------------------------------------------------------------------
-- mark_wl_deal_paid — BUYER declares the fiat payment was sent.
-- ---------------------------------------------------------------------------
create or replace function mark_wl_deal_paid(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
  v_buyer_id uuid;
  v_marked timestamptz;
begin
  select d.status, d.buyer_id, d.payment_marked_at
    into v_status, v_buyer_id, v_marked
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'mark paid: status must be ESCROW (got %)', v_status;
  end if;
  if v_buyer_id is distinct from p_actor_id then
    raise exception 'mark paid: buyer only';
  end if;
  -- Idempotent: a second click is a no-op, never a re-stamp.
  if v_marked is not null then return; end if;

  update wl_deals set payment_marked_at = now(), updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- confirm_wl_deal_payment — SELLER confirms the fiat payment arrived.
-- Requires the buyer to have declared it first, so the two records always pair.
-- ---------------------------------------------------------------------------
create or replace function confirm_wl_deal_payment(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
  v_seller_id uuid;
  v_marked timestamptz;
  v_confirmed timestamptz;
begin
  select d.status, d.seller_id, d.payment_marked_at, d.payment_confirmed_at
    into v_status, v_seller_id, v_marked, v_confirmed
    from wl_deals d where d.id = p_deal_id for update;
  if v_status is null then raise exception 'deal not found'; end if;
  if v_status <> 'ESCROW' then
    raise exception 'confirm payment: status must be ESCROW (got %)', v_status;
  end if;
  if v_seller_id is distinct from p_actor_id then
    raise exception 'confirm payment: seller only';
  end if;
  if v_marked is null then
    raise exception 'confirm payment: buyer has not marked the payment as sent yet';
  end if;
  if v_confirmed is not null then return; end if;

  update wl_deals set payment_confirmed_at = now(), updated_at = now() where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- mark_wl_deal_delivered — now gated on the fiat payment being confirmed.
-- Supersedes the 0072 definition.
-- ---------------------------------------------------------------------------
create or replace function mark_wl_deal_delivered(p_deal_id uuid, p_actor_id uuid)
returns void as $$
declare
  v_status text;
  v_seller_id uuid;
  v_delivered_at timestamptz;
  v_fiat_leg boolean;
  v_paid boolean;
begin
  select d.status, d.seller_id, d.delivered_at, d.fiat_leg,
         (d.payment_confirmed_at is not null)
    into v_status, v_seller_id, v_delivered_at, v_fiat_leg, v_paid
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
  -- Fiat deals only: the seller must have confirmed the money landed first.
  if v_fiat_leg and not v_paid then
    raise exception 'mark delivered: confirm the fiat payment was received first';
  end if;

  update wl_deals
     set delivered_at = now(),
         confirm_deadline = now() + interval '7 days',
         updated_at = now()
   where id = p_deal_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- Audit actions for the fiat payment trail
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
    -- 0072
    'WL_DEAL_DELIVERED','WL_DEAL_DISPUTED','SLASH_COLLATERAL',
    -- 0074
    'WL_DEAL_PAID','WL_DEAL_PAYMENT_CONFIRMED'
  ));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function mark_wl_deal_paid(uuid, uuid) to service_role;
grant execute on function confirm_wl_deal_payment(uuid, uuid) to service_role;
grant execute on function mark_wl_deal_delivered(uuid, uuid) to service_role;
grant execute on function mark_wl_deal_paid(uuid, uuid) to postgres;
grant execute on function confirm_wl_deal_payment(uuid, uuid) to postgres;
grant execute on function mark_wl_deal_delivered(uuid, uuid) to postgres;
