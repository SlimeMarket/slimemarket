-- ============================================================================
-- SlimeMarket — 0019: resolve_dispute_atomic RPC for admin dispute resolution.
-- Admin resolves DISPUTED order: refund buyer (100%) or release seller (98/2).
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_dispute_atomic(p_order_id uuid, p_actor_id uuid, p_decision text, p_reason text)
RETURNS void AS $$
DECLARE
  v_status text; v_buyer_id uuid; v_amount bigint; v_circle bigint; v_gas bigint;
  v_locked bigint; v_buyer_wallet uuid; v_seller_wallet uuid;
  v_store_id uuid; v_group_id uuid;
  v_fee bigint; v_payout bigint; v_gas_total bigint;
BEGIN
  SELECT status, buyer_id, amount, circle_fee, gas_fee, store_id
    INTO v_status, v_buyer_id, v_amount, v_circle, v_gas, v_store_id
    FROM orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_status <> 'DISPUTED' THEN RAISE EXCEPTION 'resolve: order must be DISPUTED (got %)', v_status; END IF;
  -- Admin check
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor_id AND role = 'Admin') THEN
    RAISE EXCEPTION 'resolve: Admin only';
  END IF;

  v_locked := v_amount + v_circle + v_gas;
  SELECT id INTO v_buyer_wallet FROM wallets WHERE user_id = v_buyer_id;

  IF p_decision = 'refund' THEN
    -- Full refund to buyer
    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_locked,'ref_id',p_order_id::text),
      jsonb_build_object('account','user_wallet','direction','CR','amount',v_locked,'wallet_id',v_buyer_wallet,'ref_id',p_order_id::text)
    ));
    UPDATE wallets SET usdc_balance = usdc_balance + v_locked WHERE id = v_buyer_wallet;
    UPDATE orders SET status = 'CANCELLED', cancel_reason = p_reason, updated_at = now() WHERE id = p_order_id;

  ELSIF p_decision = 'release' THEN
    -- Release to seller (98/2 split, same as confirm_order_atomic)
    SELECT w.id INTO v_seller_wallet FROM wallets w JOIN stores s ON s.owner_user_id = w.user_id WHERE s.id = v_store_id;
    v_fee := (v_amount * 200) / 10000;
    v_payout := v_amount - v_fee;
    v_gas_total := v_circle + v_gas;

    v_group_id := ledger_post(jsonb_build_array(
      jsonb_build_object('account','escrow_holding','direction','DR','amount',v_locked,'ref_id',p_order_id::text),
      jsonb_build_object('account','seller_payout','direction','CR','amount',v_payout,'wallet_id',v_seller_wallet,'ref_id',p_order_id::text),
      jsonb_build_object('account','platform_fee','direction','CR','amount',v_fee,'ref_id',p_order_id::text),
      jsonb_build_object('account','gas_pool','direction','CR','amount',v_gas_total,'ref_id',p_order_id::text)
    ));
    UPDATE wallets SET usdc_balance = usdc_balance + v_payout WHERE id = v_seller_wallet;
    UPDATE orders SET status = 'DONE', updated_at = now() WHERE id = p_order_id;
    -- Bump seller tx_count
    UPDATE users SET tx_count = tx_count + 1 WHERE id = (SELECT owner_user_id FROM stores WHERE id = v_store_id);
  ELSE
    RAISE EXCEPTION 'resolve: decision must be refund or release';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
