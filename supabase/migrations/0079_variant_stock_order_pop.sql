-- ============================================================================
-- 0079_variant_stock_order_pop — make checkout actually use per-variant stock
--
-- BUG: stock lived in two places and each order path only understood one.
--
--   * `products.stock_items` (text[], migration 0003) — the legacy flat FIFO.
--   * `product_stock_items` (migration 0037) — one row per credential, keyed by
--     variant_label. `createProduct` writes HERE and leaves the flat array empty
--     whenever the seller supplied per-variant stock.
--
--   `create_order_atomic` (custodial) called the legacy `pop_stock_fifo`, which
--   reads the flat array → a per-variant product always failed with
--   "insufficient stock (have 0, want 1)" while the storefront advertised stock.
--
--   `create_non_custodial_order` read `product_stock_items` only → the mirror
--   image: a legacy product could never be bought.
--
--   `pop_stock_fifo_variant` / `stock_count_variant` were added by 0037 but no
--   order path ever called them, so the "new" stock mechanism was write-only.
--
-- FIX:
--   * `pop_stock_fifo_auto(product, variant, qty)` — dispatches to the
--     variant-aware pop when per-variant rows exist, else the legacy array.
--   * `pop_one_stock_item(product, variant)` — pops a single credential from
--     either source, for the non-custodial per-item loop.
--   * Both order functions are redefined with ONLY their stock-pop changed;
--     every other line matches the live definition they replace.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Dispatcher: prefer per-variant rows, fall back to the legacy text[] FIFO.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pop_stock_fifo_auto(
  p_product_id uuid,
  p_variant_label text,
  p_qty int
) RETURNS jsonb AS $$
DECLARE
  v_variant_rows int := 0;
BEGIN
  IF p_qty IS NULL OR p_qty < 1 THEN
    RAISE EXCEPTION 'qty must be >= 1';
  END IF;

  SELECT count(*) INTO v_variant_rows
  FROM product_stock_items
  WHERE product_id = p_product_id
    AND variant_label = coalesce(p_variant_label, 'Default')
    AND status = 'available';

  IF v_variant_rows > 0 THEN
    RETURN pop_stock_fifo_variant(p_product_id, coalesce(p_variant_label, 'Default'), p_qty);
  END IF;

  RETURN pop_stock_fifo(p_product_id, p_qty);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public';

GRANT EXECUTE ON FUNCTION pop_stock_fifo_auto(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION pop_stock_fifo_auto(uuid, text, int) TO postgres;

-- Postgres grants EXECUTE to PUBLIC by default, which makes every new function
-- anon-callable through PostgREST. These two are SECURITY DEFINER and move
-- inventory, so they must never be reachable without a session. 0078 ran before
-- this migration and therefore could not see them; 0080 re-runs its sweep as a
-- safety net, but revoke here too so a fresh database is never exposed at all.
REVOKE ALL ON FUNCTION pop_stock_fifo_auto(uuid, text, int) FROM anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Pop ONE credential from whichever stock store the product uses.
-- Returns NULL when nothing is left (the caller raises).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pop_one_stock_item(
  p_product_id uuid,
  p_variant_label text
) RETURNS text AS $$
DECLARE
  v_secret text;
  v_items  text[];
BEGIN
  SELECT secret INTO v_secret
  FROM product_stock_items
  WHERE product_id = p_product_id
    AND (coalesce(p_variant_label, 'Default') = 'Default' OR variant_label = p_variant_label)
    AND status = 'available'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_secret IS NOT NULL THEN
    UPDATE product_stock_items SET status = 'sold'
    WHERE product_id = p_product_id AND secret = v_secret AND status = 'available';
    RETURN v_secret;
  END IF;

  -- Legacy flat array: take the head, write the tail back.
  SELECT stock_items INTO v_items FROM products WHERE id = p_product_id FOR UPDATE;
  IF v_items IS NULL OR array_length(v_items, 1) IS NULL OR array_length(v_items, 1) = 0 THEN
    RETURN NULL;
  END IF;

  v_secret := v_items[1];
  v_items := CASE WHEN array_length(v_items, 1) > 1 THEN v_items[2:] ELSE '{}'::text[] END;
  UPDATE products
     SET stock_items = v_items,
         status = CASE WHEN array_length(v_items, 1) IS NULL THEN 'soldout' ELSE status END
   WHERE id = p_product_id;

  RETURN v_secret;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public';

GRANT EXECUTE ON FUNCTION pop_one_stock_item(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION pop_one_stock_item(uuid, text) TO postgres;

-- Same reason as above. This one was verified reachable with the anon key:
--   POST /rest/v1/rpc/pop_one_stock_item {"p_product_id":"…","p_variant_label":"Default"}
--   → 200 "NFLX-0006-1679"   (a real credential, no auth, no payment)
REVOKE ALL ON FUNCTION pop_one_stock_item(uuid, text) FROM anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- create_order_atomic — same as 0067 except the stock pop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_order_atomic(
  p_buyer_id    uuid,
  p_store_id    uuid,
  p_product_id  uuid,
  p_variant     text,
  p_qty         int,
  p_buyer_fee   text,
  p_gas_fee     text,
  p_payment     text,
  p_delivery    text,
  p_terms       text[],
  p_credentials jsonb,
  p_instant     boolean
) RETURNS uuid AS $$
DECLARE
  v_oid           uuid := gen_random_uuid();
  v_buyer_wallet  uuid;
  v_product_price bigint;
  v_item_amount   bigint;
  v_buyer_fee     bigint := coalesce(nullif(p_buyer_fee,'')::bigint, 0);
  v_total_debit   bigint;
  v_buyer_bal     bigint;
  v_pop_result    jsonb;
  v_creds         jsonb := p_credentials;
  v_status        text := 'PENDING';
  v_group_id      uuid;
BEGIN
  SELECT id INTO v_buyer_wallet FROM wallets WHERE user_id = p_buyer_id;
  IF v_buyer_wallet IS NULL THEN RAISE EXCEPTION 'create_order: buyer wallet not found'; END IF;

  SELECT price INTO v_product_price FROM products WHERE id = p_product_id FOR UPDATE;
  IF v_product_price IS NULL THEN RAISE EXCEPTION 'create_order: product not found'; END IF;

  v_item_amount := v_product_price * p_qty;
  v_total_debit := v_item_amount + v_buyer_fee;

  SELECT usdc_balance INTO v_buyer_bal FROM wallets WHERE id = v_buyer_wallet FOR UPDATE;
  IF wallet_available_balance(v_buyer_wallet) < v_total_debit THEN
    RAISE EXCEPTION 'insufficient balance for checkout (need %)', v_total_debit;
  END IF;

  -- instant: pop stock FIFO atomically — variant-aware when applicable
  IF p_instant THEN
    SELECT pop_stock_fifo_auto(p_product_id, p_variant, p_qty) INTO v_pop_result;
    IF v_pop_result ? 'items' THEN
      SELECT v_pop_result->'items' INTO v_creds;
    END IF;
    v_status := 'SENT';
  END IF;

  INSERT INTO orders (id, buyer_id, store_id, product_id, variant, qty, amount,
    buyer_fee, circle_fee, gas_fee, payment, delivery, status, terms)
  VALUES (v_oid, p_buyer_id, p_store_id, p_product_id, p_variant, p_qty, v_item_amount,
    v_buyer_fee, 0, 0, p_payment, p_delivery, v_status, p_terms);

  v_group_id := ledger_post(jsonb_build_array(
    jsonb_build_object('account','user_wallet','direction','DR','amount',v_total_debit,'wallet_id',v_buyer_wallet,'ref_id',v_oid::text),
    jsonb_build_object('account','escrow_holding','direction','CR','amount',v_item_amount,'ref_id',v_oid::text),
    jsonb_build_object('account','platform_fee','direction','CR','amount',v_buyer_fee,'ref_id',v_oid::text)
  ));

  UPDATE wallets SET usdc_balance = usdc_balance - v_total_debit WHERE id = v_buyer_wallet;

  IF v_creds IS NOT NULL AND v_creds <> '{}'::jsonb THEN
    UPDATE orders SET credentials_vault_ref = v_creds::text WHERE id = v_oid;
  END IF;

  RETURN v_oid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public';

-- ---------------------------------------------------------------------------
-- create_non_custodial_order — ALWAYS 'PENDING', no stock pop.
--
-- Restores the 0048/0057 invariant: at prepare time NOTHING may be consumed.
-- 0056 had silently replaced 0048's fix with pre-0048 logic that popped stock
-- and flipped the draft to 'SENT' immediately, which made the on-chain path
-- unreachable ("order status SENT cannot challenge (expected one of: PENDING)")
-- and let an abandoned draft eat seller stock. Stock pop / SENT / credentials
-- belong to `auto_advance_instant_order`, which runs only after the buyer's
-- approve tx is verified.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_non_custodial_order(
  p_buyer_id  uuid,
  p_store_id  uuid,
  p_product_id uuid,
  p_variant   text,
  p_qty       integer,
  p_payment   text,
  p_delivery  text,
  p_terms     jsonb,
  p_buyer_fee text DEFAULT '0'::text
) RETURNS uuid AS $$
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

  IF p_terms IS NOT NULL AND jsonb_typeof(p_terms) = 'array' THEN
    SELECT ARRAY(SELECT jsonb_array_elements_text(p_terms)) INTO v_terms;
  ELSE
    v_terms := '{}';
  END IF;

  -- Draft is ALWAYS 'PENDING' here — instant and manual alike (0048 invariant,
  -- restored by 0057). The challenge route and validateDraftForConfirm require
  -- PENDING, and no stock may be consumed before payment is verified.
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public';

COMMENT ON FUNCTION public.create_non_custodial_order(uuid, uuid, uuid, text, integer, text, text, jsonb, text)
  IS 'Non-custodial checkout draft. ALWAYS inserts status=PENDING (0048 invariant, restored by 0057). Stock pop/SENT/credentials happen at confirm via auto_advance_instant_order.';

-- ---------------------------------------------------------------------------
-- auto_advance_instant_order — this is where instant stock is actually consumed
-- (after payment). Same as 0044 except the per-item pop goes through
-- pop_one_stock_item, which covers BOTH the per-variant table and the legacy
-- flat array. Previously it read product_stock_items only, so a legacy-stock
-- product could never be fulfilled: "insufficient stock to fulfill instant
-- order (have 0, want 1)" at confirm — i.e. after the buyer had already paid.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_advance_instant_order(
  p_order_id uuid, p_actor_id uuid
) RETURNS jsonb AS $$
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

  -- Pop qty credentials FIFO for the order's product + variant. pop_one_stock_item
  -- covers both stores so a product is fulfillable whichever one it uses.
  FOR v_i IN 1..v_qty LOOP
    v_secret := pop_one_stock_item(v_product_id, v_variant);

    IF v_secret IS NULL THEN
      RAISE EXCEPTION 'insufficient stock to fulfill instant order (have %, want %)',
        coalesce(array_length(v_stock_secrets, 1), 0), v_qty;
    END IF;

    v_stock_secrets := v_stock_secrets || v_secret;
  END LOOP;

  UPDATE orders
     SET status = 'SENT',
         credentials_vault_ref = to_jsonb(v_stock_secrets)::text,
         sent_at = now()
   WHERE id = p_order_id;

  -- Auto-soldout when neither store has anything left.
  SELECT count(*) INTO v_remaining FROM product_stock_items
  WHERE product_id = v_product_id AND status = 'available';

  IF v_remaining = 0 THEN
    SELECT coalesce(array_length(stock_items, 1), 0) INTO v_remaining
    FROM products WHERE id = v_product_id;
  END IF;

  IF v_remaining = 0 THEN
    UPDATE products SET status = 'soldout' WHERE id = v_product_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'SENT',
    'credentials', to_jsonb(v_stock_secrets),
    'remaining', v_remaining
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public';

GRANT EXECUTE ON FUNCTION auto_advance_instant_order(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION auto_advance_instant_order(uuid, uuid) TO postgres;

-- Fail loudly if the fix did not apply.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'pop_stock_fifo_auto') THEN
    RAISE EXCEPTION '0079 failed: pop_stock_fifo_auto was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'pop_one_stock_item') THEN
    RAISE EXCEPTION '0079 failed: pop_one_stock_item was not created';
  END IF;
  -- The draft must never be born SENT again.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'create_non_custodial_order' LIMIT 1)
     NOT LIKE '%''PENDING''%' THEN
    RAISE EXCEPTION '0079 failed: create_non_custodial_order no longer inserts PENDING';
  END IF;
END $$;
