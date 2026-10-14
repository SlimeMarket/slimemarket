-- 0081 — allow `create_pending` in orders.on_chain_status
--
-- BUG: the non-custodial relay can succeed while the contract id is not yet
-- readable from the receipt. In that window the code correctly records the
-- intent as `create_pending` so the reconcile job can backfill it later:
--
--   lib/order/checkout.ts:777   on_chain_status: onChainOrderId ? "CREATED" : "create_pending"
--   lib/wl/transitions.ts:809   on_chain_status: onChainDealId ? "CREATED" : (relaySucceeded ? "create_pending" : null)
--   app/api/admin/dashboard/route.ts:114  .in("on_chain_status", [... , "create_pending"])
--
-- …but the CHECK constraint never listed that value, so the write was rejected:
--
--   new row for relation "orders" violates check constraint "orders_on_chain_status_check"
--
-- Because the whole UPDATE failed, `on_chain_order_id` / `on_chain_tx_hash` were
-- never persisted. The order kept status SENT with NULL ids, confirm returned
-- { degraded: true, paymentPending: true }, and `/api/admin/reconcile/onchain-ids`
-- could not find it either (nothing was ever marked pending) — a permanently
-- stuck order, with the buyer's USDC already moved on-chain.
--
-- Adding the value the application already writes restores the intended flow:
-- the row persists, the reconcile job sees it, and the id is backfilled.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_on_chain_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_on_chain_status_check
  CHECK (
    on_chain_status IS NULL
    OR on_chain_status = ANY (ARRAY[
      'CREATED',
      'create_pending',
      'release_pending',
      'refund_pending',
      'RELEASED',
      'REFUNDED',
      'release_failed',
      'refund_failed'
    ]::text[])
  );

COMMENT ON CONSTRAINT orders_on_chain_status_check ON orders IS
  'Allowed on-chain lifecycle states. create_pending = relay accepted but the contract id is not readable yet; /api/admin/reconcile/onchain-ids backfills it.';
