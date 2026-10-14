-- ---------------------------------------------------------------------------
-- 0076 — missing wallet_txs columns used by the admin treasury withdrawal.
--
-- `app/api/admin/treasury/withdraw/route.ts` writes two columns that do not exist
-- on `wallet_txs`:
--
--     dest_address      (insert, line ~145)
--     ucw_challenge_id  (update, line ~180)
--
-- Both would make the write fail, so an admin treasury withdrawal could never be
-- recorded — and because the record is what the rest of the flow polls for state,
-- the withdrawal would appear to hang rather than fail cleanly.
--
-- These are real domain fields (where the money is going, and which Circle
-- challenge is settling it), so they get proper columns rather than being folded
-- into the generic `metadata` blob.
-- ---------------------------------------------------------------------------

alter table public.wallet_txs
  add column if not exists dest_address text,
  add column if not exists ucw_challenge_id text;

comment on column public.wallet_txs.dest_address is
  'External destination address for an external_transfer withdrawal.';
comment on column public.wallet_txs.ucw_challenge_id is
  'Circle user-controlled-wallet challenge id settling this transaction, when the signer is a UCW.';

-- The withdrawal flow looks rows up by challenge id when polling state.
create index if not exists wallet_txs_ucw_challenge_idx
  on public.wallet_txs (ucw_challenge_id)
  where ucw_challenge_id is not null;
