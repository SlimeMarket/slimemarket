-- ---------------------------------------------------------------------------
-- 0098 — allow orders.on_chain_status = 'create_failed'
--
-- `reconcileMissingOnchainIds` marks an order whose Circle creation tx reached
-- a TERMINAL failed state (e.g. ESTIMATION_ERROR): no USDC ever moved, so the
-- order is cancelled and stock restocked. The status column had no value for
-- that outcome, so the write silently violated the check constraint and the
-- order stayed `create_pending` — picked up again (and again) on every run.
-- ---------------------------------------------------------------------------

alter table public.orders drop constraint if exists orders_on_chain_status_check;

alter table public.orders add constraint orders_on_chain_status_check
  check (
    on_chain_status is null
    or on_chain_status = any (array[
      'CREATED',
      'create_pending',
      'create_failed',
      'release_pending',
      'refund_pending',
      'RELEASED',
      'REFUNDED',
      'release_failed',
      'refund_failed'
    ]::text[])
  );

comment on constraint orders_on_chain_status_check on public.orders is
  'Allowed on-chain lifecycle states. create_pending = relay accepted, contract id not readable yet; create_failed = relay terminated, no funds moved.';
