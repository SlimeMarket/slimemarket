-- ============================================================================
-- 0038_variant_price_rpc — make `create_non_custodial_order` variant-aware.
--
-- 0034 introduced instant-delivery support to `create_non_custodial_order`
-- but the price computation still used the product's base `price` column,
-- ignoring the per-variant price stored in the `variants` jsonb. When a
-- seller publishes a product with multiple price variants (e.g. "1 Month"
-- $5, "3 Months" $12, "Lifetime" $40), the order amount must reflect the
-- chosen variant — not the base price.
--
-- Also: instant-delivery products with per-variant stock (migration 0037's
-- `product_stock_items` table) must pop from the variant-specific pool via
-- `pop_stock_fifo_variant` instead of the legacy single-pool `pop_stock_fifo`.
-- The legacy `products.stock_items` text[] is still used as a fallback for
-- single-variant instant products (no rows in `product_stock_items`).
-- ============================================================================

CREATE OR REPLACE FUNCTION create_non_custodial_order(
  p_buyer_id uuid,
  p_store_id uuid,
  p_product_id uuid,
  p_variant text,
  p_qty int,
  p_payment text,
  p_delivery text,
  p_terms text[]
) RETURNS uuid AS $$
DECLARE
  v_oid uuid := gen_random_uuid();
  v_product_price bigint;
  v_item_amount bigint;
  v_status text := 'PENDING';
  v_pop_result jsonb;
  v_creds jsonb := '{}'::jsonb;
  v_variants jsonb;
  v_variant_price bigint;
  v_has_variant_rows int;
  v_variant_label text := COALESCE(NULLIF(p_variant, ''), 'Default');
BEGIN
  IF p_qty < 1 THEN RAISE EXCEPTION 'qty must be >= 1'; END IF;

  SELECT price, variants INTO v_product_price, v_variants
    FROM products WHERE id = p_product_id FOR UPDATE;
  IF v_product_price IS NULL THEN RAISE EXCEPTION 'product not found'; END IF;

  -- Resolve variant price (fallback to base price).
  v_variant_price := v_product_price;
  IF p_variant IS NOT NULL AND p_variant != 'Default' AND v_variants IS NOT NULL THEN
    SELECT (elem->>'price')::bigint INTO v_variant_price
      FROM jsonb_array_elements(v_variants) AS elem
      WHERE elem->>'label' = p_variant
      LIMIT 1;
    IF v_variant_price IS NULL THEN v_variant_price := v_product_price; END IF;
  END IF;

  v_item_amount := v_variant_price * p_qty;

  IF p_delivery = 'instant' THEN
    -- Prefer per-variant stock table (migration 0037) when it has rows for
    -- this product/variant; otherwise fall back to the legacy flat text[]
    -- FIFO pop on products.stock_items.
    SELECT count(*) INTO v_has_variant_rows
      FROM product_stock_items
      WHERE product_id = p_product_id
        AND variant_label = v_variant_label
        AND status = 'available';
    IF v_has_variant_rows >= p_qty THEN
      SELECT pop_stock_fifo_variant(p_product_id, v_variant_label, p_qty) INTO v_pop_result;
      IF v_pop_result ? 'items' THEN
        SELECT v_pop_result->'items' INTO v_creds;
      END IF;
      v_status := 'SENT';
    ELSE
      -- Legacy single-pool pop (works for products without per-variant rows).
      SELECT pop_stock_fifo(p_product_id, p_qty) INTO v_pop_result;
      IF v_pop_result ? 'items' THEN
        SELECT v_pop_result->'items' INTO v_creds;
      END IF;
      v_status := 'SENT';
    END IF;
  END IF;

  INSERT INTO orders (id, buyer_id, store_id, product_id, variant, qty, amount,
    circle_fee, gas_fee, payment, delivery, status, terms)
  VALUES (v_oid, p_buyer_id, p_store_id, p_product_id, v_variant_label, p_qty, v_item_amount,
    0, 0, p_payment, p_delivery, v_status, p_terms);

  IF v_creds <> '{}'::jsonb AND v_creds IS NOT NULL THEN
    UPDATE orders SET credentials_vault_ref = v_creds::text WHERE id = v_oid;
  END IF;

  RETURN v_oid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_non_custodial_order TO service_role;
GRANT EXECUTE ON FUNCTION create_non_custodial_order TO postgres;
