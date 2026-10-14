-- 0091 — cross-chain bridge intents (CCTP into Arc)
--
-- WHY: a buyer holding USDC on Base/Avalanche/Arbitrum cannot pay an Arc escrow
-- with it. Buyers with an external wallet use the App Kit bridge. Email-login
-- (UCW) buyers cannot — that bridge is EIP-1193 based and needs `window.ethereum`
-- — so we drive CCTP directly: approve + depositForBurn signed with their PIN,
-- then a permissionless receiveMessage on Arc.
--
-- That flow is MULTI-STEP and spans two chains, with the user's own wallet as
-- the signer. Between the steps the browser can close, the tab can die, or the
-- user can simply walk away mid-flow. So the intent has to be durable:
--   * which source chain + wallet + amount, and which Arc address receives it
--   * how far it got (approved? burned? attested? minted?)
--   * the tx hashes, so any step can be verified on-chain rather than trusted
--
-- Without this table a half-finished bridge is invisible: USDC has left the
-- user's source-chain wallet and nothing on our side knows it exists. That is
-- the single worst outcome here, so the row is written BEFORE the burn.
--
-- ⚠️ This table is SERVER-ONLY. Every write goes through `supabaseAdminClient()`
-- (service role) from a route that has already authenticated the user and
-- verified the tx on-chain. There are deliberately NO policies: RLS is on with a
-- default-deny, and anon/authenticated hold no grants. A user must not be able
-- to mark their own bridge MINTED, or point `arc_recipient` at someone else.
--
-- See lib/cctp/chains.ts, lib/cctp/burn.ts, lib/cctp/attestation.ts.

begin;

create table if not exists cross_chain_bridges (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,

  -- Source side (where the USDC starts).
  source_chain      text not null,                 -- CCTP source key, e.g. "baseSepolia"
  source_wallet_id  text not null,                 -- Circle wallet id (UCW)
  source_address    text not null,                 -- 0x… on the source chain
  amount_micro      numeric(38, 0) not null check (amount_micro > 0),

  -- Destination side (Arc).
  arc_recipient     text not null,                 -- 0x… credited on Arc
  arc_domain        integer not null default 26,   -- CCTP domain; 26 on Arc testnet AND mainnet

  -- Progress. PREPARED is written before any signature is requested.
  status            text not null default 'PREPARED'
                    check (status in ('PREPARED','APPROVED','BURNED','ATTESTED','MINTED','FAILED')),

  approve_tx_hash   text,
  burn_tx_hash      text,
  burn_block        bigint,
  attestation       text,
  mint_tx_hash      text,

  -- Populated on FAILED; never surfaced raw to the user (see clientErrorMessage).
  error             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Idempotency for the confirm step: a retried confirm must not create a second
-- row for the same on-chain burn. Partial, because burn_tx_hash is NULL until
-- the burn happens and Postgres would otherwise allow only one such row ever.
create unique index if not exists cross_chain_bridges_burn_tx_hash_key
  on cross_chain_bridges (burn_tx_hash)
  where burn_tx_hash is not null;

-- The two access patterns: a user's own history, and the relay worker scanning
-- for burns that still need minting on Arc.
create index if not exists cross_chain_bridges_user_created_idx
  on cross_chain_bridges (user_id, created_at desc);
create index if not exists cross_chain_bridges_pending_idx
  on cross_chain_bridges (status, burn_block)
  where status in ('BURNED', 'ATTESTED');

comment on table cross_chain_bridges is
  'Durable CCTP bridge intents (source chain -> Arc). Server-only; written via service role.';
comment on column cross_chain_bridges.arc_domain is
  'CCTP destination domain for Arc. 26 on both testnet and mainnet (verified from @circle-fin/provider-cctp-v2).';
comment on column cross_chain_bridges.status is
  'PREPARED -> APPROVED -> BURNED -> ATTESTED -> MINTED, or FAILED. Steps are verifiable on-chain from the stored tx hashes.';

-- Deny-by-default for every client role. The service role bypasses RLS, and no
-- browser code reads this table directly (the UI goes through /api/wallet/cross-chain/*).
alter table cross_chain_bridges enable row level security;

revoke all on public.cross_chain_bridges from anon, authenticated;
revoke all on public.cross_chain_bridges from public;

-- Keep updated_at honest without trusting callers to send it.
create or replace function touch_cross_chain_bridges_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cross_chain_bridges_touch_updated_at on public.cross_chain_bridges;
create trigger cross_chain_bridges_touch_updated_at
  before update on public.cross_chain_bridges
  for each row execute function touch_cross_chain_bridges_updated_at();

-- Same rule as every other function-creating migration: CREATE OR REPLACE
-- resets EXECUTE to PUBLIC, and a trigger function is callable by anyone who can
-- reach it through PostgREST. Revoke explicitly.
revoke all on function touch_cross_chain_bridges_updated_at() from anon, authenticated, public;

commit;
