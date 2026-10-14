-- ============================================================================
-- .E — lifecycle_events guard migration
-- ============================================================================
-- Two migrations share the "0044_" prefix (0044_auto_advance_instant_order +
-- 0044_lifecycle_events). Depending on the applier, only one ran, leaving
-- environments WITHOUT the lifecycle_events table/grants — settlement paths
-- then silently degrade (bestEffortPersist logs, money path unaffected).
--
-- This migration re-asserts the table + grants idempotently so EVERY
-- environment has the settlement timeline table (RELEASED/REFUNDED rows are
-- part of the seller auto-settlement guarantee).
-- ============================================================================

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
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_order
ON public.lifecycle_events(order_id, created_at DESC);

-- Grants: 0044_lifecycle_events only granted the helper function to
-- authenticated. The service_role admin client does the inserts — it needs
-- table + sequence access (this was the silent failure mode).
GRANT ALL ON public.lifecycle_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE lifecycle_events_id_seq TO service_role;
