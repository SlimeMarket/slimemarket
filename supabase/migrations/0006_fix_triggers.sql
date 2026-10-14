-- ============================================================================
-- SlimeMarket — 0006_fix_triggers: add missing updated_at columns.
--
-- The M0 trigger loop (0001_init.sql) created a BEFORE UPDATE trigger calling
-- set_updated_at() on every application table. But 6 tables were created
-- WITHOUT an `updated_at` column, so any UPDATE on them crashes:
--   ERROR: record "new" has no field "updated_at"
--
-- Affected (trigger present, column missing):
--   bank_accounts, chat_messages, notifications, reviews, secret_vault,
--   wallet_txs
--
-- This surfaced in M1 because credit_wallet_atomic / debit_wallet_atomic
-- UPDATE wallet_txs for the first time. Fix: add the column (matching the M0
-- intent that all app tables track updated_at). Idempotent.
-- ============================================================================

alter table bank_accounts   add column if not exists updated_at timestamptz not null default now();
alter table chat_messages   add column if not exists updated_at timestamptz not null default now();
alter table notifications   add column if not exists updated_at timestamptz not null default now();
alter table reviews         add column if not exists updated_at timestamptz not null default now();
alter table secret_vault    add column if not exists updated_at timestamptz not null default now();
alter table wallet_txs      add column if not exists updated_at timestamptz not null default now();
