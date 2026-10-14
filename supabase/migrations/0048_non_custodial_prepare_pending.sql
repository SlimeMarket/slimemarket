-- ============================================================================
-- 0048_non_custodial_prepare_pending — checkout lifecycle fixes (B1/B2/B3/B4)
-- ============================================================================
--
-- B1 FIX: 0043 made create_non_custodial_order pop stock FIFO and flip the
-- draft straight to 'SENT' at PREPARE time for instant products. That broke
-- the guards (challenge route and validateDraftForConfirm both
-- expect 'PENDING' → "order status SENT cannot challenge"), attached
-- credentials BEFORE payment, and every failed/abandoned buy permanently
-- consumed stock ('sold' rows never restocked).
--
-- This migration replaces the RPC with one that keeps the draft 'PENDING'
-- for BOTH instant and manual delivery. Signature and return shape are
-- preserved EXACTLY (lib/order/checkout.ts:prepareCheckoutOrder depends on
-- it); only the instant auto-advance block from 0043 is removed. Stock is
-- now popped at CONFIRM time (B2) via the existing
-- public.auto_advance_instant_order (0044) — that RPC already performs the
-- exact pop+SENT+credentials+auto-soldout semantics the removed block had,
-- keyed by order id, so no new advance RPC is introduced.
--
-- B3 FIX: restock_instant_order(p_order_id, p_target_status) — transactional
-- undo for stuck instant drafts (status 'SENT' but the on-chain relay never
-- happened: on_chain_order_id AND on_chain_tx_hash both null/empty). It
-- returns the order's stock items to 'available' and moves the order to
-- p_target_status: 'CANCELLED' (the B3 sweep) or 'PENDING' (the B2 confirm
-- relay-failure rollback — a retryable draft the buyer can confirm again).
-- In both cases the never-paid credentials are cleared and a product that
-- 0043 auto-soldout'd is re-activated.
--
-- HEURISTIC (documented): the schema has NO order→stock linkage — 0037's
-- product_stock_items rows carry (product_id, variant_label, secret, status)
-- only; 0043/0044 never recorded which rows an order consumed. Restock
-- therefore matches by (product_id, variant_label, status='sold') up to the
-- order's qty, taking the MOST RECENTLY created rows first: FIFO pop always
-- sells the OLDEST rows first, so the most recently 'sold' rows are the ones
-- the most recent stuck order consumed. The whole restock runs under
-- FOR UPDATE SKIP LOCKED inside one transaction; callers (the draft sweep)
-- process stuck orders oldest-first, which keeps the heuristic consistent.
--
-- B4 FIX: confirm_order_noncustodial + auto_release_expired_orders_noncustodial
-- — no-credit variants of the 0007/0025 release RPCs. In non-custodial mode
-- (ONCHAIN_WALLET_FUNDS=1) the on-chain MarketEscrow.releaseOrder pays the
-- seller 98% DIRECTLY to their wallet; crediting wallets.usdc_balance on top
-- would double-book money the platform does not hold (and Withdraw would
-- then send funds out of the platform DCW that it never received). These
-- variants keep the exact guards (SENT, actor), the SENT→DONE flip, and the
-- buyer tx_count bump, but perform NO ledger_post and NO wallet credit.
-- Custodial mode (flag off) keeps calling the original RPCs — unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- B1: prepare stays PENDING (0043 minus the instant auto-advance block)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_non_custodial_order(
  p_buyer_id uuid, p_store_id uuid, p_product_id uuid,
  p_variant text, p_qty integer, p_payment text,
  p_delivery text, p_terms jsonb, p_buyer_fee text DEFAULT '0'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_product_price bigint;
  v_item_amount bigint;
  v_buyer_fee bigint;
  v_order_id uuid;
  v_terms text[];
BEGIN
  SELECT price INTO v_product_price FROM products WHERE id = p_product_id;
  IF v_product_price IS NULL THEN RAISE EXCEPTION 'product not found'; END IF;

  IF p_variant IS NOT NULL AND p_variant != 'Default' THEN
    SELECT (v->>'price')::bigint INTO v_product_price
    FROM products, jsonb_array_elements(variants) AS v
    WHERE products.id = p_product_id AND v->>'label' = p_variant;
  END IF;

  v_item_amount := v_product_price * p_qty;
  v_buyer_fee := COALESCE(p_buyer_fee::bigint, 0);

  -- Convert jsonb array to text[] for the orders.terms column
  IF p_terms IS NOT NULL AND jsonb_typeof(p_terms) = 'array' THEN
    SELECT ARRAY(SELECT jsonb_array_elements_text(p_terms)) INTO v_terms;
  ELSE
    v_terms := '{}';
  END IF;

  -- Draft is ALWAYS 'PENDING' here — instant and manual alike. The - guards (challenge route, validateDraftForConfirm) require PENDING, and no
  -- stock may be consumed / credentials attached before the buyer's approve
  -- tx is verified and the createOrderFor relay runs (see
  -- lib/order/checkout.ts:confirmCheckoutOrder + auto_advance_instant_order).
  INSERT INTO orders (
    buyer_id, store_id, product_id, variant, qty,
    amount, buyer_fee, circle_fee, gas_fee,
    payment, delivery, status, terms
  ) VALUES (
    p_buyer_id, p_store_id, p_product_id, p_variant, p_qty,
    v_item_amount, v_buyer_fee, 0, 0,
    p_payment, p_delivery, 'PENDING', v_terms
  ) RETURNING id INTO v_order_id;

  RETURN v_order_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- B3/B2: restock a stuck instant draft (transactional undo of the stock pop).
-- p_target_status: where the order goes afterwards — 'CANCELLED' (stuck-draft
-- sweep) or 'PENDING' (confirm relay-failure rollback; retryable draft).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restock_instant_order(p_order_id uuid, p_target_status text DEFAULT 'CANCELLED')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_status text;
  v_delivery text;
  v_product_id uuid;
  v_variant text;
  v_qty int;
  v_chain_order_id text;
  v_chain_tx_hash text;
  v_row record;
  v_restocked int := 0;
  v_remaining int;
  v_prod_status text;
BEGIN
  IF p_target_status NOT IN ('CANCELLED', 'PENDING') THEN
    RAISE EXCEPTION 'restock: invalid target status %', p_target_status;
  END IF;

  SELECT o.status, o.delivery, o.product_id, o.variant, o.qty,
         o.on_chain_order_id, o.on_chain_tx_hash
    INTO v_status, v_delivery, v_product_id, v_variant, v_qty,
         v_chain_order_id, v_chain_tx_hash
    FROM orders o
   WHERE o.id = p_order_id
   FOR UPDATE OF o;

  IF v_status IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;

  -- Idempotent safety: only stuck instant drafts that never reached the chain
  -- may be restocked. Anything else (already DONE/CANCELLED, or with any
  -- on-chain reference) is skipped, never modified.
  IF v_status <> 'SENT' OR v_delivery <> 'instant' THEN
    RETURN jsonb_build_object('restocked', 0, 'skipped', true);
  END IF;
  IF v_chain_order_id IS NOT NULL OR (v_chain_tx_hash IS NOT NULL AND v_chain_tx_hash <> '') THEN
    RETURN jsonb_build_object('restocked', 0, 'skipped', true);
  END IF;

  -- Restock up to qty items by (product, variant) among 'sold' rows, most
  -- recently created first (FIFO pop sold the oldest first — see header).
  FOR v_row IN
    SELECT id FROM product_stock_items
    WHERE product_id = v_product_id
      AND (v_variant = 'Default' OR variant_label = v_variant)
      AND status = 'sold'
    ORDER BY created_at DESC
    LIMIT v_qty
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE product_stock_items SET status = 'available' WHERE id = v_row.id;
    v_restocked := v_restocked + 1;
  END LOOP;

  -- Move the stuck order to the target status and drop the never-paid
  -- credentials (they were attached at confirm/advance, payment never landed).
  UPDATE orders
     SET status = p_target_status,
         cancel_reason = CASE p_target_status
           WHEN 'CANCELLED' THEN 'stuck instant draft: relay never reached chain, stock restocked'
           ELSE NULL
         END,
         credentials_vault_ref = NULL,
         sent_at = NULL
   WHERE id = p_order_id;

  -- If 0043 auto-soldout'd the product and stock is now available again,
  -- re-activate it so the storefront shows it as buyable.
  SELECT count(*) INTO v_remaining FROM product_stock_items
  WHERE product_id = v_product_id AND status = 'available';

  IF v_remaining > 0 THEN
    SELECT status INTO v_prod_status FROM products WHERE id = v_product_id;
    IF v_prod_status = 'soldout' THEN
      UPDATE products SET status = 'active' WHERE id = v_product_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('restocked', v_restocked, 'product_id', v_product_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.restock_instant_order(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restock_instant_order(uuid, text) TO postgres;

-- ---------------------------------------------------------------------------
-- B4: SENT→DONE without any ledger/wallet credit (buyer-confirm path)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_order_noncustodial(p_order_id uuid, p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_status text;
  v_buyer_id uuid;
BEGIN
  SELECT status, buyer_id INTO v_status, v_buyer_id
    FROM orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_status <> 'SENT' THEN RAISE EXCEPTION 'confirm: status must be SENT (got %)', v_status; END IF;
  IF p_actor_id <> v_buyer_id THEN RAISE EXCEPTION 'confirm: not buyer'; END IF;

  -- NO ledger_post, NO wallets.usdc_balance credit: in non-custodial mode the
  -- on-chain MarketEscrow.releaseOrder pays the seller directly (98%); the
  -- custodial ledger credit would double-book money the platform doesn't hold.

  UPDATE orders SET status = 'DONE' WHERE id = p_order_id;
  UPDATE users SET tx_count = tx_count + 1 WHERE id = v_buyer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_order_noncustodial(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_order_noncustodial(uuid, uuid) TO postgres;

-- ---------------------------------------------------------------------------
-- B4: 42h auto-release without any ledger/wallet credit (no-credit variant of
-- 0025's auto_release_expired_orders; same loop, same return shape)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_release_expired_orders_noncustodial()
RETURNS setof orders LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order record;
BEGIN
  FOR v_order IN
    SELECT * FROM orders
     WHERE status = 'SENT'
       AND release_deadline IS NOT NULL
       AND release_deadline < now()
     FOR UPDATE OF orders
  LOOP
    -- NO ledger_post, NO wallets.usdc_balance credit — the on-chain
    -- releaseOrder (driven by lib/order/auto-release.ts right after this)
    -- pays the seller directly in non-custodial mode.

    UPDATE orders SET status = 'DONE', updated_at = now() WHERE id = v_order.id;
    UPDATE users SET tx_count = tx_count + 1 WHERE id = v_order.buyer_id;

    RETURN NEXT v_order;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_release_expired_orders_noncustodial() TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_release_expired_orders_noncustodial() TO postgres;
