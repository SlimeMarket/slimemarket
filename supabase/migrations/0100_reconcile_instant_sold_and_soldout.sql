-- 0100: keep products.sold / products.status honest for instant orders.
--
-- The auto_advance_instant_order RPC (0044) pops `product_stock_items` rows
-- from `available` to `sold` and flips the product to `soldout` when no
-- available rows remain. But it never bumped `products.sold`, so the
-- "Sold" count shown to sellers drifted further from reality with every
-- sale, and the home/explore visibility filter (which hides `soldout`) only
-- worked if the seller remembered to mark the product sold out by hand.
--
-- Two changes:
--   1. Patch the RPC to maintain `products.sold` and `products.stock` for
--      every instant sale and to (re)evaluate `status='soldout'` from the
--      authoritative `product_stock_items` table.
--   2. Backfill the same values for every existing instant product so the
--      seller center shows the correct "0 sold" / "Sold Out" state without
--      waiting for the next order.

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

  -- Keep `products.sold` and `products.stock` in sync with the authoritative
  -- `product_stock_items` table. The seller center shows `sold`; the legacy
  -- `stock_items` text[] and the manual `stock` column were never decremented
  -- for instant orders, so this also brings them in line.
  UPDATE products p
     SET sold    = COALESCE(p.sold, 0) + v_qty,
         stock   = GREATEST(COALESCE(p.stock, 0) - v_qty, 0)
   WHERE p.id = v_product_id;

  -- Auto-soldout when no available stock items remain. The `variant_label`
  -- filter is permissive on purpose: a product with non-Default variants is
  -- only sold-out if every variant is out of stock.
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

REVOKE ALL ON FUNCTION public.auto_advance_instant_order(uuid, uuid) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.auto_advance_instant_order(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_advance_instant_order(uuid, uuid) TO postgres;

-- Backfill every existing instant product so the seller center reads true
-- numbers and home/explore stop showing products that are actually sold out.
-- 0 available ⇒ soldout;  >0 available & currently soldout ⇒ reactivate.
UPDATE products p
   SET sold = COALESCE(s.sold_count, 0),
       stock = COALESCE(s.sold_count, 0) -- for instant products, `stock` mirrors sold items
  FROM (
    SELECT product_id,
           count(*) FILTER (WHERE status = 'sold')   AS sold_count,
           count(*) FILTER (WHERE status = 'available') AS available_count
      FROM product_stock_items
     GROUP BY product_id
  ) s
 WHERE p.delivery = 'instant'
   AND p.id = s.product_id
   AND (p.sold IS DISTINCT FROM s.sold_count
        OR p.stock IS DISTINCT FROM s.sold_count);

UPDATE products p
   SET status = 'soldout'
 WHERE p.delivery = 'instant'
   AND p.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM product_stock_items
      WHERE product_id = p.id AND status = 'available'
   );

UPDATE products p
   SET status = 'active'
 WHERE p.delivery = 'instant'
   AND p.status = 'soldout'
   AND EXISTS (
     SELECT 1 FROM product_stock_items
      WHERE product_id = p.id AND status = 'available'
   );
