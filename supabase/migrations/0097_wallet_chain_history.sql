-- ============================================================================
-- 0097 — Chain-backed wallet history cache
--
-- Problem: Blockscout/Etherscan API does not serve Arc testnet (and the
-- mainnet explorer returns HTML, not JSON). The only reliable source of
-- truth is the RPC itself (eth_getLogs).
--
-- Because scanning millions of blocks on every page load is too slow, we
-- cache native-USDC Transfer events per wallet and resume incrementally.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- wallet_chain_txs  (on-chain native USDC transfers, mirrored from RPC)
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_chain_txs (
  id           uuid primary key default gen_random_uuid(),
  wallet_id    uuid not null references wallets(id) on delete cascade,
  tx_hash      text not null,
  block_number bigint not null,
  "from"       text not null,
  "to"         text not null,
  amount       bigint not null,          -- raw on-chain value (Arc native USDC decimals)
  direction    text not null check (direction in ('in','out')),
  scanned_at   timestamptz not null default now()
);

-- One row per (wallet, tx_hash). A tx can involve a wallet as either sender
-- or receiver, never both in the same native transfer.
create unique index if not exists wallet_chain_txs_wallet_tx_hash_uniq
  on public.wallet_chain_txs (wallet_id, tx_hash);

create index if not exists wallet_chain_txs_wallet_block_idx
  on public.wallet_chain_txs (wallet_id, block_number desc);

-- ---------------------------------------------------------------------------
-- last_scanned_block on wallets  (resume cursor for incremental scan)
-- ---------------------------------------------------------------------------
alter table public.wallets
  add column if not exists last_scanned_block bigint;

comment on column public.wallets.last_scanned_block is
  'Highest block number already scanned for this wallet’s on-chain USDC history. NULL = never scanned.';
