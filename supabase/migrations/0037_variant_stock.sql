-- ============================================================================
-- 0037_variant_stock — per-variant stock items table + variant-aware pop/count
--
-- The legacy `products.stock_items` is a single text[] shared across all
-- variants. When a product has multiple price variants (e.g. "1 Month",
-- "3 Months", "Lifetime"), each variant needs its own independent stock pool.
-- This migration introduces `product_stock_items` — one row per credential —
-- keyed by (product_id, variant_label).
--
-- Backwards compatible: products without per-variant rows continue to use the
-- old `stock_items` text[] FIFO path (`pop_stock_fifo`). The variant-aware
-- functions (`pop_stock_fifo_variant`, `stock_count_variant`) are NEW and are
-- only called when the seller actually defined per-variant stock at create
-- time (see lib/catalog/products.ts: createProduct).
-- ============================================================================

-- Per-variant stock items table
CREATE TABLE IF NOT EXISTS product_stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_label text NOT NULL DEFAULT 'Default',
  secret text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','sold','reserved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_items_product_variant
  ON product_stock_items(product_id, variant_label, status);

-- Grant
GRANT SELECT, INSERT, UPDATE ON product_stock_items TO service_role;
GRANT SELECT, INSERT, UPDATE ON product_stock_items TO postgres;

-- Variant-aware stock pop function
CREATE OR REPLACE FUNCTION pop_stock_fifo_variant(
  p_product_id uuid,
  p_variant_label text,
  p_qty int
) RETURNS jsonb AS $$
DECLARE
  v_items jsonb := '[]'::jsonb;
  v_row record;
  v_count int := 0;
BEGIN
  IF p_qty < 1 THEN RAISE EXCEPTION 'qty must be >= 1'; END IF;

  FOR v_row IN
    SELECT id, secret FROM product_stock_items
    WHERE product_id = p_product_id AND variant_label = p_variant_label AND status = 'available'
    ORDER BY created_at ASC
    LIMIT p_qty
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE product_stock_items SET status = 'sold' WHERE id = v_row.id;
    v_items := v_items || jsonb_build_array(v_row.secret);
    v_count := v_count + 1;
  END LOOP;

  IF v_count < p_qty THEN
    RAISE EXCEPTION 'insufficient stock for variant %: have %, need %', p_variant_label, v_count, p_qty;
  END IF;

  RETURN jsonb_build_object('items', v_items, 'count', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION pop_stock_fifo_variant TO service_role;
GRANT EXECUTE ON FUNCTION pop_stock_fifo_variant TO postgres;

-- Count available stock per variant
CREATE OR REPLACE FUNCTION stock_count_variant(
  p_product_id uuid,
  p_variant_label text
) RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM product_stock_items
  WHERE product_id = p_product_id AND variant_label = p_variant_label AND status = 'available';
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION stock_count_variant TO service_role;
GRANT EXECUTE ON FUNCTION stock_count_variant TO postgres;
