-- 0044: auto_advance_instant_order — let sellers one-click instant orders
-- Problem: Instant-delivery orders stuck in PENDING show "Set Process" and
-- require the seller to manually deliver credentials, even though stock was
-- provided upfront. Instant orders should auto-send credentials from stock.
-- Fix: Atomic RPC that pops `qty` stock items for the order's product/variant
-- (FIFO, row-locked), marks the order SENT with the popped credentials, and
-- auto-sets the product to soldout when all stock is consumed.
-- Also works for legacy PENDING instant orders created before 0043.

CREATE OR REPLACE FUNCTION public.auto_advance_instant_order(
  p_order_id uuid, p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_status text;
  v_delivery text;
  v_store_owner uuid;
  v_product_id uuid;
  v_variant text;
  v_qty int;
  v_secret text;
  v_i int;
  v_stock_secrets text[] := '{}'::text[];
  v_remaining int;
BEGIN
  SELECT o.status, o.delivery, o.product_id, o.variant, o.qty, s.owner_user_id
    INTO v_status, v_delivery, v_product_id, v_variant, v_qty, v_store_owner
    FROM orders o JOIN stores s ON s.id = o.store_id
   WHERE o.id = p_order_id FOR UPDATE OF o;

  IF v_status IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'auto-advance: status must be PENDING (got %)', v_status;
  END IF;
  IF p_actor_id <> v_store_owner THEN
    RAISE EXCEPTION 'auto-advance: not store owner';
  END IF;
  IF v_delivery <> 'instant' THEN
    RAISE EXCEPTION 'auto-advance: order is not instant delivery';
  END IF;

  -- Pop qty stock items FIFO for the order's product + variant.
  FOR v_i IN 1..v_qty LOOP
    SELECT secret INTO v_secret FROM product_stock_items
    WHERE product_id = v_product_id
      AND (v_variant = 'Default' OR variant_label = v_variant)
      AND status = 'available'
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;

    IF v_secret IS NULL THEN
      RAISE EXCEPTION 'insufficient stock to fulfill instant order (have %, want %)',
        coalesce(array_length(v_stock_secrets, 1), 0), v_qty;
    END IF;

    UPDATE product_stock_items SET status = 'sold'
    WHERE product_id = v_product_id AND secret = v_secret AND status = 'available';

    v_stock_secrets := v_stock_secrets || v_secret;
  END LOOP;

  -- Mark order SENT with the popped credentials (JSON array of lines).
  UPDATE orders
     SET status = 'SENT',
         credentials_vault_ref = to_jsonb(v_stock_secrets)::text,
         sent_at = now()
   WHERE id = p_order_id;

  -- Auto-soldout when all product stock is consumed.
  SELECT count(*) INTO v_remaining FROM product_stock_items
  WHERE product_id = v_product_id AND status = 'available';

  IF v_remaining = 0 THEN
    UPDATE products SET status = 'soldout' WHERE id = v_product_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'SENT',
    'credentials', to_jsonb(v_stock_secrets),
    'remaining', v_remaining
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_advance_instant_order(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_advance_instant_order(uuid, uuid) TO postgres;
