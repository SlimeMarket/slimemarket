-- Migration 0044: Add lifecycle events table for order tracking
-- Inspired by Circle Commerce Payments Protocol

CREATE TABLE IF NOT EXISTS public.lifecycle_events (
  id              BIGSERIAL PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  operation       TEXT NOT NULL CHECK (operation IN (
    'CREATED',
    'AUTHORIZED', 
    'FUNDS_LOCKED',
    'CAPTURED',
    'RELEASED',
    'REFUNDED',
    'VOIDED',
    'DISPUTED',
    'RESOLVED',
    'SHIPPED'
  )),
  tx_hash         TEXT,
  amount          NUMERIC(20,6),
  note            TEXT,  -- "partial" for partial captures/refunds
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast order timeline queries
CREATE INDEX IF NOT EXISTS idx_lifecycle_order 
ON public.lifecycle_events(order_id, created_at DESC);

-- Create function to insert lifecycle event
CREATE OR REPLACE FUNCTION add_lifecycle_event(
  p_order_id UUID,
  p_operation TEXT,
  p_tx_hash TEXT DEFAULT NULL,
  p_amount NUMERIC DEFAULT NULL,
  p_note TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.lifecycle_events (order_id, operation, tx_hash, amount, note)
  VALUES (p_order_id, p_operation, p_tx_hash, p_amount, p_note);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION add_lifecycle_event TO authenticated;
