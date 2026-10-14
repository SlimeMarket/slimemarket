-- ============================================================================
-- SlimeMarket — 0018: Add 'dispute' type to chat_threads for mediasi rooms.
-- ============================================================================

ALTER TABLE chat_threads DROP CONSTRAINT IF EXISTS chat_threads_type_check;
ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_type_check
  CHECK (type = ANY (ARRAY['normal','escrow','forum','dispute']));
