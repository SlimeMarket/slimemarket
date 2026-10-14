-- ---------------------------------------------------------------------------
-- 0075 — settlement record for auto-release.
--
-- `app/api/orders/[id]/auto-release/route.ts` reads AND writes three columns that
-- never existed on `orders`:
--
--     settled_at, settlement_tx_hash, auto_released
--
-- The read is the fatal half. The route's very first query selects all three, so
-- PostgREST rejected it, `order` came back null, and the handler answered
-- "Order not found" (404) — for EVERY order. Auto-release was therefore 100%
-- dead: no order could ever be released by the cron, no matter how long the buyer
-- stayed silent. The write half would have failed too, had the read ever passed.
--
-- The columns are legitimate domain data (when the escrow was released, by which
-- transaction, and whether the platform did it automatically), so the fix is to
-- add them rather than rewrite the route around unrelated columns.
--
-- Backfill: existing orders that already reached a released state get
-- `settled_at` from `updated_at`, which is the closest true value available.
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists settled_at timestamptz,
  add column if not exists settlement_tx_hash text,
  add column if not exists auto_released boolean not null default false;

comment on column public.orders.settled_at is
  'When the escrow was released on-chain. NULL = not yet settled.';
comment on column public.orders.settlement_tx_hash is
  'Circle transaction id of the release. Paired with settled_at for idempotency.';
comment on column public.orders.auto_released is
  'True when the platform released this automatically (buyer went silent) rather than the buyer confirming.';

-- Backfill: orders already in a released state were settled at some point.
-- `updated_at` is the best available approximation; leaving it NULL would make
-- the route re-attempt a release for every historical order.
update public.orders
   set settled_at = coalesce(settled_at, updated_at),
       auto_released = coalesce(auto_released, false)
 where status in ('RELEASED', 'DONE')
   and settled_at is null;

-- Supports the cron's "find releaseable orders" scan.
create index if not exists orders_release_scan_idx
  on public.orders (status, release_deadline)
  where settled_at is null;
