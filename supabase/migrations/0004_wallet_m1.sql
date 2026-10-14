-- ============================================================================
-- SlimeMarket — 0004_wallet_m1: M1 wallet & fiat ramp schema (SINGLE SOURCE).
-- Code in lib/wallet/{withdraw,faucet,crypto-withdraw}.ts calls these RPCs with
-- p_amount as TEXT (bigint.toString()). Money = bigint micro-USDC. Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- blocklist_addresses  (ARC on-chain blocklist — checked before on-chain send)
-- Server-only (RLS deny all). Populated by admin/compliance.
-- ---------------------------------------------------------------------------
create table if not exists blocklist_addresses (
  address    text primary key,
  reason     text,
  created_at timestamptz not null default now()
);
alter table blocklist_addresses enable row level security;
drop policy if exists blocklist_addresses_none on blocklist_addresses;
create policy blocklist_addresses_none on blocklist_addresses for select using (false);

-- ---------------------------------------------------------------------------
-- ledger_entries.account: add 'external_fiat' for on/off-ramp offset.
-- ---------------------------------------------------------------------------
do $$
declare v_conname text;
begin
  select conname into v_conname from pg_constraint
   where contype = 'c'
     and conrelid = 'ledger_entries'::regclass
     and pg_get_constraintdef(oid) like '%account%';
  if v_conname is not null then
    execute format('alter table ledger_entries drop constraint %I', v_conname);
  end if;
end$$;
alter table ledger_entries
  add constraint ledger_entries_account_check
  check (account in (
    'user_wallet','escrow_holding','platform_fee','seller_payout',
    'referral_payout','gas_pool','collateral_hold','external_fiat'
  ));

-- ---------------------------------------------------------------------------
-- wallet_txs: ramp columns added by M1
-- ---------------------------------------------------------------------------
alter table wallet_txs
  add column if not exists method          text check (method in ('qris','card','bank','onchain','cctp')),
  add column if not exists fiat_amount     bigint,
  add column if not exists fiat_currency   text,
  add column if not exists holding_until   timestamptz,
  add column if not exists arc_tx_hash     text,
  add column if not exists bank_account_id uuid references bank_accounts(id) on delete set null;

create index if not exists wallet_txs_circle_tx_idx     on wallet_txs(circle_tx_id);
create index if not exists wallet_txs_holding_until_idx on wallet_txs(holding_until);
create index if not exists wallet_txs_wallet_status_idx on wallet_txs(wallet_id, status);

-- ---------------------------------------------------------------------------
-- wallet_available_balance(p_wallet_id)  — STABLE, read-only.
-- ---------------------------------------------------------------------------
create or replace function wallet_available_balance(p_wallet_id uuid)
returns bigint as $$
declare v_balance bigint; v_held bigint;
begin
  select usdc_balance into v_balance from wallets where id = p_wallet_id;
  if not found then raise exception 'wallet_available_balance: wallet not found: %', p_wallet_id; end if;
  select coalesce(sum(amount), 0) into v_held from wallet_txs
   where wallet_id = p_wallet_id and type = 'in' and status = 'done'
     and holding_until is not null and holding_until > now();
  return v_balance - v_held;
end;
$$ language plpgsql security definer stable;

-- ---------------------------------------------------------------------------
-- credit_wallet_atomic(p_wallet_id, p_amount TEXT, p_ref_id, p_wallet_tx_id, p_holding_hours)
-- Idempotent (no-op if status != 'pending'). Posts ledger, bumps balance, sets hold.
-- ---------------------------------------------------------------------------
create or replace function credit_wallet_atomic(
  p_wallet_id uuid, p_amount text, p_ref_id text, p_wallet_tx_id uuid, p_holding_hours int default 72
) returns uuid as $$
declare
  v_amount bigint := p_amount::bigint;
  v_st text; v_group_id uuid; v_entries jsonb;
begin
  if v_amount is null or v_amount <= 0 then raise exception 'credit_wallet_atomic: amount must be positive'; end if;
  select status into v_st from wallet_txs where id = p_wallet_tx_id for update;
  if v_st is null then raise exception 'credit_wallet_atomic: wallet_tx not found: %', p_wallet_tx_id; end if;
  if v_st <> 'pending' then return null; end if;
  perform 1 from wallets where id = p_wallet_id for update;
  if not found then raise exception 'credit_wallet_atomic: wallet not found: %', p_wallet_id; end if;
  v_entries := jsonb_build_array(
    jsonb_build_object('account','external_fiat','direction','DR','amount',v_amount,'ref_id',p_ref_id),
    jsonb_build_object('account','user_wallet','direction','CR','amount',v_amount,'wallet_id',p_wallet_id,'ref_id',p_ref_id)
  );
  v_group_id := ledger_post(v_entries);
  update wallets set usdc_balance = usdc_balance + v_amount where id = p_wallet_id;
  update wallet_txs set status = 'done', amount = v_amount,
    holding_until = case when p_holding_hours > 0 then now() + (p_holding_hours::text || ' hours')::interval else null end
   where id = p_wallet_tx_id;
  return v_group_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- debit_wallet_atomic(p_wallet_id, p_amount TEXT, p_ref_id, p_wallet_tx_id)
-- Idempotent. Asserts available balance. Posts ledger, decrements balance.
-- ---------------------------------------------------------------------------
create or replace function debit_wallet_atomic(
  p_wallet_id uuid, p_amount text, p_ref_id text, p_wallet_tx_id uuid
) returns uuid as $$
declare
  v_amount bigint := p_amount::bigint;
  v_st text; v_available bigint; v_group_id uuid; v_entries jsonb;
begin
  if v_amount is null or v_amount <= 0 then raise exception 'debit_wallet_atomic: amount must be positive'; end if;
  select status into v_st from wallet_txs where id = p_wallet_tx_id for update;
  if v_st is null then raise exception 'debit_wallet_atomic: wallet_tx not found: %', p_wallet_tx_id; end if;
  if v_st <> 'pending' then return null; end if;
  perform 1 from wallets where id = p_wallet_id for update;
  if not found then raise exception 'debit_wallet_atomic: wallet not found: %', p_wallet_id; end if;
  v_available := wallet_available_balance(p_wallet_id);
  if v_available < v_amount then raise exception 'insufficient available balance (have %, want %)', v_available, v_amount; end if;
  v_entries := jsonb_build_array(
    jsonb_build_object('account','user_wallet','direction','DR','amount',v_amount,'wallet_id',p_wallet_id,'ref_id',p_ref_id),
    jsonb_build_object('account','external_fiat','direction','CR','amount',v_amount,'ref_id',p_ref_id)
  );
  v_group_id := ledger_post(v_entries);
  update wallets set usdc_balance = usdc_balance - v_amount where id = p_wallet_id;
  update wallet_txs set status = 'done', amount = v_amount where id = p_wallet_tx_id;
  return v_group_id;
end;
$$ language plpgsql security definer;
