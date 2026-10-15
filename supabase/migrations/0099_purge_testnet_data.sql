-- =============================================================================
-- 0099_purge_testnet_data.sql
--
-- Hapus SEMUA data testnet dari Supabase sebelum mainnet launch.
-- ⚠️ DESTRUCTIVE — run ini HANYA kalau udah yakin data testnet nggak dibutuhin.
--
-- Run:  psql $DATABASE_URL -f supabase/migrations/0099_purge_testnet_data.sql
-- =============================================================================

-- Disable triggers biar nggak kena RLS / foreign key cascade issues
-- (service role key bypass RLS anyway, tapi tetap aman)

-- ---------------------------------------------------------------------------
-- 1. WALLET-RELATED (truncate dulu karena FK ke users)
-- ---------------------------------------------------------------------------
DELETE FROM public.wallet_chain_txs;
DELETE FROM public.external_wallets;
DELETE FROM public.wallet_txs;
DELETE FROM public.ledger_entries;
DELETE FROM public.tx_groups;

-- ---------------------------------------------------------------------------
-- 2. ESCROW / WL (truncate dulu karena FK ke orders/users)
-- ---------------------------------------------------------------------------
DELETE FROM public.wl_deals;
DELETE FROM public.wl_listings;
DELETE FROM public.rekber_tx;
DELETE FROM public.disputes;
DELETE FROM public.mm_audit_log;
DELETE FROM public.mm_audit_log_failed;

-- ---------------------------------------------------------------------------
-- 3. ORDERS & CHAT
-- ---------------------------------------------------------------------------
DELETE FROM public.chat_messages;
DELETE FROM public.chat_threads;
DELETE FROM public.reviews;
DELETE FROM public.orders;

-- ---------------------------------------------------------------------------
-- 4. PRODUCTS & STORES
-- ---------------------------------------------------------------------------
DELETE FROM public.product_stock_items;
DELETE FROM public.products;
DELETE FROM public.stores;
DELETE FROM public.seller_applications;

-- ---------------------------------------------------------------------------
-- 5. USER-RELATED
-- ---------------------------------------------------------------------------
DELETE FROM public.referral_events;
DELETE FROM public.referrals;
DELETE FROM public.notifications;
DELETE FROM public.bank_accounts;
DELETE FROM public.recovery_wallets;
DELETE FROM public.audit_log;
DELETE FROM public.webhook_events;
DELETE FROM public.blocklist_addresses;
DELETE FROM public.indexer_state;
DELETE FROM public.reports;

-- ---------------------------------------------------------------------------
-- 6. USERS & WALLETS (terakhir karena banyak FK ke sini)
-- ---------------------------------------------------------------------------
DELETE FROM public.wallets;
DELETE FROM public.users;

-- ---------------------------------------------------------------------------
-- 7. RESET SEQUENCES (biar ID mulai dari 1 lagi)
-- ---------------------------------------------------------------------------
SELECT setval('public.users_id_seq', 1, false);
SELECT setval('public.wallets_id_seq', 1, false);
SELECT setval('public.stores_id_seq', 1, false);
SELECT setval('public.products_id_seq', 1, false);
SELECT setval('public.orders_id_seq', 1, false);
SELECT setval('public.chat_threads_id_seq', 1, false);
SELECT setval('public.chat_messages_id_seq', 1, false);
SELECT setval('public.reviews_id_seq', 1, false);
SELECT setval('public.disputes_id_seq', 1, false);
SELECT setval('public.notifications_id_seq', 1, false);
SELECT setval('public.wl_listings_id_seq', 1, false);
SELECT setval('public.wl_deals_id_seq', 1, false);
SELECT setval('public.wallet_txs_id_seq', 1, false);
SELECT setval('public.ledger_entries_id_seq', 1, false);
SELECT setval('public.referrals_id_seq', 1, false);
SELECT setval('public.seller_applications_id_seq', 1, false);
SELECT setval('public.mm_audit_log_id_seq', 1, false);

-- ---------------------------------------------------------------------------
-- 8. VACUUM (reclaim space)
-- ---------------------------------------------------------------------------
VACUUM ANALYZE;

-- =============================================================================
-- KALAU mau selective delete (cuma hapus users tertentu), pakai ini:
--
-- WITH deleted_users AS (
--   DELETE FROM public.users
--   WHERE email LIKE '%@test.com'
--      OR email LIKE '%test%'
--      OR created_at < '2026-10-15'
--   RETURNING id
-- )
-- DELETE FROM public.wallets WHERE user_id IN (SELECT id FROM deleted_users);
-- ...dst
-- =============================================================================
