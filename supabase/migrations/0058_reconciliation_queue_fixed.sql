-- Migration: Add reconciliation queue for best-effort persistence pattern
-- Purpose: Track orders that need manual reconciliation after on-chain success but DB write failure

CREATE TABLE IF NOT EXISTS reconciliation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES wl_deals(id) ON DELETE CASCADE,
  error_message TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  
  -- Index optimization
  CONSTRAINT reconciliation_queue_single_order UNIQUE(order_id)
);

-- Index for finding unresolved items quickly
CREATE INDEX idx_unresolved_reconciliations 
ON reconciliation_queue(created_at) 
WHERE resolved = FALSE;

-- Index for retry scheduling
CREATE INDEX idx_retry_queue 
ON reconciliation_queue(retry_at) 
WHERE resolved = FALSE AND retry_at IS NOT NULL;

-- Function to add entry to reconciliation queue
CREATE OR REPLACE FUNCTION add_to_reconciliation_queue(
  _order_id UUID,
  _error_msg TEXT
)
RETURNS VOID AS $$
BEGIN
  -- Only add if not already in queue
  IF NOT EXISTS (SELECT 1 FROM reconciliation_queue WHERE order_id = _order_id AND resolved = FALSE) THEN
    INSERT INTO reconciliation_queue (order_id, error_message, retry_at)
    VALUES (_order_id, _error_msg, NOW() + INTERVAL '5 minutes');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to remove entry from reconciliation queue
CREATE OR REPLACE FUNCTION resolve_reconciliation_entry(
  _entry_id UUID,
  _resolved_by TEXT,
  _new_order_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_order_id UUID;
BEGIN
  SELECT order_id INTO v_order_id FROM reconciliation_queue WHERE id = _entry_id;
  
  IF v_order_id IS NOT NULL THEN
    UPDATE reconciliation_queue SET
      resolved = TRUE,
      resolved_by = _resolved_by,
      resolved_at = NOW(),
      -- If new order ID is provided, update the original entry
      order_id = COALESCE(_new_order_id, order_id)
    WHERE id = _entry_id;
    
    -- If a new order was created, notify it was reconciled
    IF _new_order_id IS NOT NULL THEN
      RAISE NOTICE 'Reconciliation completed: % -> %', v_order_id, _new_order_id;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get next batch of entries ready for retry
CREATE OR REPLACE FUNCTION get_next_reconciliation_batch(batch_size INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  order_id UUID,
  error_message TEXT,
  created_at TIMESTAMPTZ,
  attempts INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT r.id, r.order_id, r.error_message, r.created_at, r.attempts
  FROM reconciliation_queue r
  WHERE r.resolved = FALSE
    AND (r.retry_at IS NULL OR r.retry_at <= NOW())
    AND r.attempts < 3
  ORDER BY r.created_at ASC
  LIMIT batch_size;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment retry counter and schedule next attempt
CREATE OR REPLACE FUNCTION mark_reconciliation_attempted(_entry_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE reconciliation_queue SET
    attempts = attempts + 1,
    retry_at = NOW() + (attempts + 1 * INTERVAL '5 minutes') * 2 -- Exponential backoff
  WHERE id = _entry_id AND resolved = FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add comment explaining purpose
COMMENT ON TABLE reconciliation_queue IS 
'Store for orders/deals that failed database write but succeeded on-chain. 
These require manual reconciliation by admin or background job.';

COMMENT ON FUNCTION add_to_reconciliation_queue IS 
'Best-effort persistence helper: called when on-chain succeeds but DB fails.';

COMMENT ON FUNCTION get_next_reconciliation_batch IS 
'Background job calls this to find entries ready for retry.';

-- Grant permissions to postgres role (used by Supabase)
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
