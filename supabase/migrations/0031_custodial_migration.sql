-- ============================================================================
-- 0031_custodial_migration — track migration of old custodial balances to UCW.
--
-- Before disabling the legacy custodial ledger (where wallets.usdc_balance was
-- the spendable balance), each user's DB balance must be sent as REAL USDC to
-- their UCW on-chain via `fundUcwFromTreasury`. This migration adds columns
-- to track which wallets have been migrated, so the process is:
--   - Idempotent (re-running the migration script skips already-migrated rows)
--   - Auditable (each row has the Circle tx id + timestamp)
--   - Resumable (server crash mid-batch leaves the row 'pending'; next run
--     either completes it or marks it for manual review via reconcile cron)
-- ============================================================================

alter table wallets add column if not exists custodial_migrated_at timestamptz;
alter table wallets add column if not exists custodial_migration_tx_id text;
alter table wallets add column if not exists custodial_migration_status text
  default null
  check (custodial_migration_status is null
         or custodial_migration_status in ('pending','migrated','failed','skipped'));

-- Index for the migration script's WHERE clause: find unmigrated wallets.
create index if not exists idx_wallets_custodial_migration
  on wallets(custodial_migration_status)
  where custodial_migration_status is null or custodial_migration_status = 'pending';

-- Add a distinct ledger account for migration entries so they don't pollute
-- the existing 'platform_fee' / 'gas_pool' accounts. The ledger_entries
-- account column is text (no CHECK constraint per 0001_init.sql:232), so a
-- new value can be inserted without a migration.
comment on column wallets.custodial_migrated_at is
  'Timestamp when this wallet''s custodial balance was migrated to on-chain USDC via fundUcwFromTreasury. NULL = not yet migrated.';
comment on column wallets.custodial_migration_tx_id is
  'Circle tx id of the fundUcwFromTreasury call that migrated this wallet''s balance.';
comment on column wallets.custodial_migration_status is
  'Migration status: NULL = not started, pending = tx submitted but not yet confirmed, migrated = tx confirmed + on-chain balance verified, failed = tx failed + needs manual review, skipped = wallet not eligible (DCW/mock/dev/no-address).';
