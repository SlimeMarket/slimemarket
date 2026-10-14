-- ============================================================================
-- SlimeMarket — 0026_treasury_payout: proper fee account debit for treasury
-- withdrawals. Replaces credit_wallet_atomic usage in treasury/withdraw route.
--
-- PROBLEM: credit_wallet_atomic DRs 'external_fiat' — creating money from
-- thin air. Treasury payouts must DR from actual fee accounts (platform_fee
-- or gas_pool) where collected fees are credited.
--
-- This function:
-- 1. Locks wallet_txs row (idempotent: no-op if not 'pending')
-- 2. Locks recipient wallet
-- 3. Posts ledger: DR source_account, CR user_wallet
-- 4. Credits recipient wallet balance
-- 5. Marks wallet_txs as done
-- ============================================================================

create or replace function treasury_payout_atomic(
  p_wallet_id      uuid,
  p_amount         text,
  p_source_account text,
  p_ref_id         text,
  p_wallet_tx_id   uuid
) returns uuid as $$
declare
  v_amount bigint := p_amount::bigint;
  v_st     text;
  v_group_id uuid;
begin
  if v_amount is null or v_amount <= 0 then
    raise exception 'treasury_payout: amount must be positive';
  end if;
  if p_source_account not in ('platform_fee', 'gas_pool') then
    raise exception 'treasury_payout: invalid source account: %', p_source_account;
  end if;

  -- lock & check wallet_txs
  select status into v_st from wallet_txs where id = p_wallet_tx_id for update;
  if v_st is null then
    raise exception 'treasury_payout: wallet_tx not found: %', p_wallet_tx_id;
  end if;
  if v_st <> 'pending' then
    return null; -- idempotent
  end if;

  -- lock recipient wallet
  perform 1 from wallets where id = p_wallet_id for update;
  if not found then
    raise exception 'treasury_payout: wallet not found: %', p_wallet_id;
  end if;

  -- ledger: DR fee account, CR user_wallet
  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account', p_source_account, 'direction', 'DR',
      'amount', v_amount, 'ref_id', p_ref_id),
    jsonb_build_object('account', 'user_wallet', 'direction', 'CR',
      'amount', v_amount, 'wallet_id', p_wallet_id, 'ref_id', p_ref_id)
  ));

  -- credit recipient wallet
  update wallets set usdc_balance = usdc_balance + v_amount where id = p_wallet_id;

  -- mark tx done (no holding period for treasury payouts)
  update wallet_txs set status = 'done', amount = v_amount, holding_until = null
   where id = p_wallet_tx_id;

  return v_group_id;
end;
$$ language plpgsql security definer;
