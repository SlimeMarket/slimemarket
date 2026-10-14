-- 0043: Fix create_non_custodial_order — instant delivery bugs
-- Problem 1: For qty > 1, the RPC only popped ONE stock item instead of qty
--            items, so multi-unit instant orders under-delivered credentials.
-- Problem 2: When instant stock is fully consumed via FIFO pop, the product
--            stays 'active' with 0 stock — buyer can still attempt checkout
--            and seller sees "Stock: 0" while listed as Active.
-- Fix: Loop-pop `p_qty` stock items (FIFO, row-locked), store ALL popped
--      credentials on the order as a JSON array (the buyer mapper parses
--      arrays of "key: value" lines), and auto-set products.status='soldout'
--      when no available items remain for the product.

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
  v_stock_secrets text[] := '{}'::text[];
  v_secret text;
  v_i int;
  v_terms text[];
  v_remaining int;
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

  INSERT INTO orders (
    buyer_id, store_id, product_id, variant, qty,
    amount, buyer_fee, circle_fee, gas_fee,
    payment, delivery, status, terms
  ) VALUES (
    p_buyer_id, p_store_id, p_product_id, p_variant, p_qty,
    v_item_amount, v_buyer_fee, 0, 0,
    p_payment, p_delivery, 'PENDING', v_terms
  ) RETURNING id INTO v_order_id;

  IF p_delivery = 'instant' THEN
    -- Pop p_qty stock items FIFO (each row-locked to prevent races).
    FOR v_i IN 1..p_qty LOOP
      SELECT secret INTO v_secret FROM product_stock_items
      WHERE product_id = p_product_id
        AND (p_variant = 'Default' OR variant_label = p_variant)
        AND status = 'available'
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;

      -- Not enough stock for the full qty — fail the whole order atomically.
      IF v_secret IS NULL THEN
        RAISE EXCEPTION 'insufficient stock for instant delivery (have %, want %)',
          coalesce(array_length(v_stock_secrets, 1), 0), p_qty;
      END IF;

      UPDATE product_stock_items SET status = 'sold'
      WHERE product_id = p_product_id AND secret = v_secret AND status = 'available';

      v_stock_secrets := v_stock_secrets || v_secret;
    END LOOP;

    -- Order is SENT with ALL popped credentials. Store as a JSON array of
    -- "key: value" strings — the buyer mapper (lib/order/mappers.ts) parses
    -- JSON arrays of lines into a credentials object.
    UPDATE orders
       SET status = 'SENT',
           credentials_vault_ref = to_jsonb(v_stock_secrets)::text,
           sent_at = now()
     WHERE id = v_order_id;

    -- Auto-set product to soldout when ALL stock for the product is consumed
    -- (no available items remain across any variant).
    SELECT count(*) INTO v_remaining FROM product_stock_items
    WHERE product_id = p_product_id AND status = 'available';

    IF v_remaining = 0 THEN
      UPDATE products SET status = 'soldout' WHERE id = p_product_id;
    END IF;
  END IF;

  RETURN v_order_id;
END;
$$;
