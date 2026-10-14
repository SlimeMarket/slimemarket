-- ============================================================================
-- SlimeMarket — 0005_grants: PostgREST role privileges (fixes M0 gap).
--
-- The M0 migrations (0001–0003) define tables + RLS policies but never GRANT
-- table privileges to the PostgREST-facing roles (anon / authenticated /
-- service_role). Without these grants, REST/GraphQL return
-- "permission denied for table X" even when RLS policies would allow the read.
--
-- Standard Supabase pattern:
--   - service_role: full DML on every table (bypasses RLS by role config).
--   - anon + authenticated: DML on client-facing tables (RLS still filters).
--   - Server-only tables (ledger_entries, tx_groups, audit_log, secret_vault,
--     webhook_events, blocklist_addresses, disputes, seller_applications):
--     REVOKE from anon/authenticated so only service_role can touch them.
--
-- Idempotent: re-running is safe.
-- ============================================================================

-- All application tables.
-- Client-facing (read/write via API + RLS):
grant select, insert, update, delete on
  users, wallets, stores, products, orders, wl_listings, wl_deals, rekber_tx,
  chat_threads, chat_messages, reviews, notifications, referrals,
  referral_events, bank_accounts, wallet_txs
to anon, authenticated;

-- Sequence usage (needed for inserts into tables with gen_random_uuid() /
-- identity columns that fall back to sequence-owned defaults).
grant usage, select on all sequences in schema public to anon, authenticated;

-- Server-only tables: REVOKE from public-facing roles, GRANT only to service_role.
revoke all on
  ledger_entries, tx_groups, audit_log, secret_vault, webhook_events,
  blocklist_addresses, disputes, seller_applications
from anon, authenticated;

-- service_role: full DML on every table (RLS is bypassed for this role by
-- Supabase's default `alter role service_role bypassrls`).
grant select, insert, update, delete on
  users, wallets, stores, products, orders, wl_listings, wl_deals, rekber_tx,
  chat_threads, chat_messages, reviews, notifications, referrals,
  referral_events, bank_accounts, wallet_txs,
  ledger_entries, tx_groups, audit_log, secret_vault, webhook_events,
  blocklist_addresses, disputes, seller_applications
to service_role;
grant usage, select on all sequences in schema public to service_role;
