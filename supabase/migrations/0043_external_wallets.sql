-- External wallet linking: users connect RainbowKit / MetaMask wallets
-- to their SlimeMarket account for external-wallet payments + Gateway ops.
create table if not exists public.external_wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  address     text not null,               -- 0x… checksummed
  chain       text not null default 'arcTestnet',
  connected_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (user_id, address)
);

-- Index for fast lookup by address (e.g. webhook / indexer)
create index if not exists idx_external_wallets_address on public.external_wallets (address);
create index if not exists idx_external_wallets_user    on public.external_wallets (user_id);

-- RLS: users can only see their own wallets
alter table public.external_wallets enable row level security;

create policy "select own wallets"
  on public.external_wallets for select
  using (auth.uid() = user_id);

create policy "insert own wallet"
  on public.external_wallets for insert
  with check (auth.uid() = user_id);

create policy "delete own wallet"
  on public.external_wallets for delete
  using (auth.uid() = user_id);
