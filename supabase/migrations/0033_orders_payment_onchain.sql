-- ============================================================================
-- 0033_orders_payment_onchain — widen orders.payment CHECK to allow 'Onchain'.
--
-- Bug: prepareCheckoutOrder passes payment='Onchain' (non-custodial mode),
-- but the existing CHECK constraint (0001_init.sql) only allows 'Saldo' and
-- 'Langsung'. This caused "new row for relation orders violates check
-- constraint orders_payment_check" during checkout.
--
-- Adding 'Onchain' as a valid payment value for non-custodial checkout.
-- ============================================================================

alter table orders drop constraint if exists orders_payment_check;
alter table orders add constraint orders_payment_check
  check (payment in ('Saldo', 'Langsung', 'Onchain'));
