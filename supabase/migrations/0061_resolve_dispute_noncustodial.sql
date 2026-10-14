-- ============================================================================
-- .A — resolve_dispute_noncustodial: the dispute/settlement RPC for
-- NON-CUSTODIAL mode (ONCHAIN_WALLET_FUNDS=1).
--
-- Why: resolve_dispute_atomic (0053) was written for the legacy custodial
-- ledger: it credits the seller wallet 98% (2% platform fee) or the buyer 100%.
-- In non-custodial mode the platform does NOT hold those funds — the on-chain
-- MarketEscrow pays seller 100% / buyer refund directly. Running the old RPC
-- there double-books money: phantom ledger credit + the real on-chain payout
-- (exactly the bug class 0048 fixed for confirm/auto-release).
--
-- This variant keeps every guard (DISPUTED status, FOR UPDATE row lock, Admin
-- actor, decision validation, terminal status flip, seller tx_count bump) but
-- performs NO ledger_post and NO wallets.usdc_balance credit. Money movement
-- is the on-chain relay's job alone in non-custodial mode.
--
-- Fee model note: the 98/2 split in 0053 is also wrong for the v4 model
-- (3% BUYER-pays, seller receives 100%); custodial legacy callers keep the old
-- function unchanged below, but the v4 fee drift is corrected in code/labels
-- via .C. This file only removes the double-book.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_dispute_noncustodial(
  p_order_id uuid,
  p_actor_id uuid,
  p_decision text,
  p_reason text
)
RETURNS void AS $$
DECLARE
  v_status text;
  v_store_id uuid;
BEGIN
  SELECT status, store_id INTO v_status, v_store_id
    FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_status <> 'DISPUTED' THEN RAISE EXCEPTION 'resolve: order must be DISPUTED (got %)', v_status; END IF;
  -- Admin check (identical to the custodial variant)
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor_id AND role = 'Admin') THEN
    RAISE EXCEPTION 'resolve: Admin only';
  END IF;

  IF p_decision = 'refund' THEN
    -- NO wallet credit: on-chain MarketEscrow.refundOrder returns the funds to
    -- the buyer directly. DB records the outcome only.
    UPDATE orders
       SET status = 'CANCELLED', cancel_reason = p_reason, updated_at = now()
     WHERE id = p_order_id;
  ELSIF p_decision = 'release' THEN
    -- NO wallet credit: on-chain MarketEscrow.releaseOrder pays the seller
    -- 100% of amount directly (3% admin fee was already collected at creation,
    -- buyer-pays model).
    UPDATE orders SET status = 'DONE', updated_at = now() WHERE id = p_order_id;
    UPDATE users SET tx_count = tx_count + 1
     WHERE id = (SELECT owner_user_id FROM stores WHERE id = v_store_id);
  ELSE
    RAISE EXCEPTION 'resolve: decision must be refund or release';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.resolve_dispute_noncustodial(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_noncustodial(uuid, uuid, text, text) TO postgres;
