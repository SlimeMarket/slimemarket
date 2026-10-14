-- ---------------------------------------------------------------------------
-- 0096 — Query-performance indexes for the hottest read paths.
--
-- WHY THIS IS NEEDED
-- ------------------
-- The schema is well indexed on primary/foreign keys, but three hot queries
-- read columns that only have SINGLE-column indexes (or none), so Postgres
-- filters fast and then pays a separate sort — or scans outright:
--
--   1. WL staff console (`GET /api/wl/deals` → listAllDeals):
--        SELECT ... FROM wl_deals ORDER BY created_at DESC   -- no filter, no limit
--      Full scan + sort of the entire table on every console load. The table
--      only ever grows, so this degrades linearly with marketplace usage.
--
--   2. "My Deals" (`listDealsForUser`):
--        WHERE buyer_id = $1 OR seller_id = $2 ORDER BY created_at DESC
--      `wl_deals_buyer_idx` covers the left half of the OR; `seller_id` had
--      NO index at all, so Postgres resolved it as index scan + seq scan.
--
--   3. "My Orders" / seller dashboards (`orders` by buyer or store, newest
--      first): single-column indexes exist, but pairing each with created_at
--      lets Postgres return rows already ordered — no separate sort step.
--
-- Indexes are additive and safe on live data (tables are still small, so
-- plain CREATE INDEX is fine — CONCURRENTLY would only matter at scale).
-- Idempotent via IF NOT EXISTS. No function/privilege changes, so the
-- REVOKE-ALL rule from 0095 does not apply here.
-- ---------------------------------------------------------------------------

create index if not exists wl_deals_seller_idx      on wl_deals(seller_id);
create index if not exists wl_deals_created_idx     on wl_deals(created_at desc);
create index if not exists orders_buyer_created_idx on orders(buyer_id, created_at desc);
create index if not exists orders_store_created_idx on orders(store_id, created_at desc);
