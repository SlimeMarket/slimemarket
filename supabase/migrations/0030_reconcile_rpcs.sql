-- ============================================================================
-- 0030_reconcile_rpcs — SQL helpers for treasury balance reconciliation.
--
-- Used by lib/reconcile/balance.ts to compare on-chain DCW USDC + escrow
-- pendingFees against the DB ledger (wallets.usdc_balance sum + pending
-- wallet_txs amount sum). Returns TEXT so BigInt parsing is safe in JS.
-- ============================================================================

create or replace function sum_wallets_balance()
returns text as $$
  select coalesce((select sum(usdc_balance)::text from wallets), '0');
$$ language sql security definer stable;

grant execute on function sum_wallets_balance to service_role;
grant execute on function sum_wallets_balance to postgres;

create or replace function sum_pending_wallet_txs()
returns text as $$
  select coalesce((select sum(amount)::text from wallet_txs where status = 'pending'), '0');
$$ language sql security definer stable;

grant execute on function sum_pending_wallet_txs to service_role;
grant execute on function sum_pending_wallet_txs to postgres;
