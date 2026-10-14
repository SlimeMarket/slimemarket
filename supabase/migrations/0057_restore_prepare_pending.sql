-- 0057: restore 0048's PENDING-at-prepare invariant for non-custodial checkout.
--
-- REGRESSION FIX. Migration 0048 (0048_non_custodial_prepare_pending.sql)
-- explicitly fixed migration 0043's bug where `create_non_custodial_order`
-- popped stock FIFO and flipped an instant draft straight to 'SENT' at PREPARE
-- time. 0048 documented the consequence:
--
--     "[0043] made create_non_custodial_order pop stock FIFO and flip the
--      draft straight to 'SENT' at PREPARE time for instant products. That
--      broke [...] ('order status SENT cannot challenge')"
--
--     "This migration replaces the RPC with one that keeps the draft 'PENDING'"
--
-- Migration 0056 (0056_non_custodial_auto_soldout.sql) then shipped a NEW body
-- for `create_non_custodial_order` — with the SAME 9-arg signature — but that
-- body was written from the pre-0048 (0043-era) logic. Because the signature is
-- identical, 0056 silently REPLACED 0048's fix and reintroduced the exact bug
-- 0048 had eliminated.
--
-- Symptom (reproduced locally 2026-09-27, ONCHAIN_WALLET_FUNDS=1, instant
-- product): checkout/prepare returns 201 but the order row is already 'SENT',
-- so the very next step fails and the whole on-chain path is unreachable:
--
--   POST /api/orders/checkout/challenge
--     → 409 {"code":"INVALID_ORDER_STATUS",
--            "error":"order status SENT cannot challenge (expected PENDING)"}
--   POST /api/orders/checkout/confirm
--     → 409 {"code":"INVALID_ORDER_STATUS",
--            "error":"order status SENT cannot confirm (expected PENDING)"}
--
-- Consequences beyond the 409s: the FIFO stock pop ran at prepare, so a buyer
-- who never paid (abandoned/cancelled draft) silently consumed seller stock,
-- and `credentials_vault_ref` was attached before any money moved.
--
-- FIX: draft is ALWAYS 'PENDING', for instant and manual alike, exactly as 0048
-- specified. No stock is popped and no credentials are attached at prepare.
-- The pop + SENT + credentials + auto-soldout for instant delivery now happen
-- ONLY at confirm, via `auto_advance_instant_order` (migration 0044), which
-- `lib/order/checkout.ts:confirmCheckoutOrder` calls after the buyer's approve
-- tx is verified and the createOrderFor relay succeeds.
--
-- 0056's auto-soldout behaviour is NOT lost: `auto_advance_instant_order`
-- (0044) already sets products.status='soldout' when no available stock
-- remains, and it is invoked from the confirm path.
--
-- Idempotent: CREATE OR REPLACE. Safe to re-run.

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

  -- Draft is ALWAYS 'PENDING' here — instant and manual alike (0048 invariant).
  -- The guards (challenge route, validateDraftForConfirm) require
  -- PENDING, and no stock may be consumed / credentials attached before the
  -- buyer's approve tx is verified and the createOrderFor relay runs (see
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

COMMENT ON FUNCTION public.create_non_custodial_order(uuid, uuid, uuid, text, integer, text, text, jsonb, text)
  IS 'Non-custodial checkout draft. ALWAYS inserts status=PENDING (0048 invariant, restored by 0057). Stock pop/SENT/credentials happen at confirm via auto_advance_instant_order.';
