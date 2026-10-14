-- 0041: Add buyer admin fee (2%) to marketplace orders.
-- Buyer pays item price + 2% admin fee. Fee covers platform gas costs.
-- Seller payout unchanged (98% of item price). Platform gets buyer fee + seller fee.

-- Add buyer_fee column to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_fee bigint NOT NULL DEFAULT 0;

-- Update create_non_custodial_order RPC to accept buyer fee
CREATE OR REPLACE FUNCTION create_non_custodial_order(
  p_buyer_id uuid,
  p_store_id uuid,
  p_product_id uuid,
  p_variant text,
  p_qty int,
  p_payment text,
  p_delivery text,
  p_terms jsonb,
  p_buyer_fee text DEFAULT '0'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_product_price bigint;
  v_item_amount bigint;
  v_buyer_fee bigint;
  v_order_id uuid;
  v_stock_item jsonb;
BEGIN
  -- Get product price (variant-aware)
  SELECT price INTO v_product_price
  FROM products
  WHERE id = p_product_id;

  IF v_product_price IS NULL THEN
    RAISE EXCEPTION 'product not found';
  END IF;

  -- Check variant price
  IF p_variant IS NOT NULL AND p_variant != 'Default' THEN
    SELECT (v->>'price')::bigint INTO v_product_price
    FROM products, jsonb_array_elements(variants) AS v
    WHERE products.id = p_product_id AND v->>'label' = p_variant;
  END IF;

  v_item_amount := v_product_price * p_qty;
  v_buyer_fee := COALESCE(p_buyer_fee::bigint, 0);

  -- Insert the order
  INSERT INTO orders (
    buyer_id, store_id, product_id, variant, qty,
    amount, buyer_fee, circle_fee, gas_fee,
    payment, delivery, status, terms
  ) VALUES (
    p_buyer_id, p_store_id, p_product_id, p_variant, p_qty,
    v_item_amount, v_buyer_fee, 0, 0,
    p_payment, p_delivery, 'PENDING', p_terms
  )
  RETURNING id INTO v_order_id;

  -- Instant delivery: pop stock FIFO
  IF p_delivery = 'instant' THEN
    SELECT data INTO v_stock_item
    FROM product_stock_items
    WHERE product_id = p_product_id
      AND (p_variant = 'Default' OR variant_label = p_variant)
      AND sold = false
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_stock_item IS NOT NULL THEN
      UPDATE product_stock_items
      SET sold = true, sold_at = now(), order_id = v_order_id
      WHERE product_id = p_product_id
        AND data = v_stock_item
        AND sold = false;

      UPDATE orders
      SET status = 'SENT',
          credentials_vault_ref = v_stock_item,
          sent_at = now()
      WHERE id = v_order_id;
    END IF;
  END IF;

  RETURN v_order_id;
END;
$$;
