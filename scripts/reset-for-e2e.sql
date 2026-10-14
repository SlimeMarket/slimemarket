-- ============================================================================
-- SlimeMarket — reset-for-e2e.sql
--
-- FULL CLEAN RESET for fresh end-to-end testing (2026-08-10).
-- Deletes ALL transactions, orders, products, WL listings/deals, forum posts,
-- DMs, stores, wallets, and every user EXCEPT the master admin:
--   KEEP: bintang7paa@gmail.com (Rimuru, uid 450Q, role Admin)
--
-- Deletion order respects all FK constraints (child → parent).
-- mm_audit_log MUST be truncated before users (NO ACTION FK mm_user_id).
-- All statements idempotent — re-running is harmless. Transactional.
--
-- Usage (from repo root):
--   docker exec -i supabase_db_slimemarket psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 --single-transaction < scripts/reset-for-e2e.sql
--
-- Verify after:
--   select (select count(*) from users) u, (select count(*) from orders) o,
--          (select count(*) from products) p, (select count(*) from stores) s,
--          (select count(*) from chat_messages) c, (select count(*) from wl_deals) w;
--   -- expected: u=1 o=0 p=0 s=0 c=0 w=0
-- ============================================================================

BEGIN;

-- Anti-footgun: this reset is ONLY for the local dev DB.
DO $$
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'reset-for-e2e refuses to run on database %', current_database();
  END IF;
END $$;

-- 1. Money/order leaf tables
TRUNCATE TABLE reviews, lifecycle_events, disputes,
             wallet_txs, ledger_entries, rekber_tx CASCADE;
TRUNCATE TABLE tx_groups CASCADE;
TRUNCATE TABLE orders CASCADE;

-- 2. Products (orders already gone)
TRUNCATE TABLE product_stock_items, products CASCADE;

-- 3. WL escrow
TRUNCATE TABLE wl_deals, wl_listings CASCADE;

-- 4. Forum + DM chat (forum posts live in chat_threads type='forum')
TRUNCATE TABLE chat_messages, chat_threads CASCADE;

-- 5. User-owned side state (mm_audit BEFORE users — NO ACTION FK!)
TRUNCATE TABLE external_wallets, notifications, referrals, referral_events,
             secret_vault, seller_applications, bank_accounts,
             mm_audit_log, mm_audit_log_failed, reports,
             audit_log CASCADE;

-- 6. Stores (virtual-store model auto-recreates on seller approval)
TRUNCATE TABLE stores CASCADE;

-- 7. Wallets then users (Rimuru re-provisions wallet on next login, .B3)
TRUNCATE TABLE wallets CASCADE;
DELETE FROM users WHERE email <> 'bintang7paa@gmail.com';

-- 8. Misc state
TRUNCATE TABLE webhook_events, indexer_state CASCADE;

-- 9. Only serial in the public schema
ALTER SEQUENCE IF EXISTS lifecycle_events_id_seq RESTART WITH 1;

-- 10. Supabase storage objects (product images bucket) are NOT deleted here:
-- storage.objects is owned by supabase_storage_admin and protected by the
-- protect_objects_delete trigger. Clean them via the Storage API instead:
--   SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2)
--   for path in $(docker exec supabase_db_slimemarket psql -U postgres -d postgres -t \
--     -c "select name from storage.objects where bucket_id='product-images';"); do
--     curl -s -X DELETE "http://127.0.0.1:54321/storage/v1/object/product-images/$path" \
--       -H "Authorization: Bearer $SUPABASE_KEY" -H "apikey: $SUPABASE_KEY"; echo
--   done

-- Rimuru's wallet row is intentionally NOT recreated: the next real login
-- upserts the real Circle wallet (unified route) and .B3 offers the
-- PIN setup challenge for the fresh account state.

COMMIT;

-- Verification snapshot
SELECT
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM orders) AS orders,
  (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM stores) AS stores,
  (SELECT count(*) FROM chat_messages) AS chat_messages,
  (SELECT count(*) FROM wl_deals) AS wl_deals,
  (SELECT count(*) FROM wallets) AS wallets;
