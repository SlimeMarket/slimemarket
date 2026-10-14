-- ============================================================================
-- SlimeMarket — 0008_order_fk: add reviews.order_id → orders FK.
-- The recovered 0001_init.sql created reviews with order_id (unique) but forgot
-- the foreign key to orders.id. PostgREST needs this FK to resolve the
-- "orders ↔ reviews" relationship used by ORDER_SELECT joins.
-- Idempotent.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where contype = 'f'
       and conrelid = 'reviews'::regclass
       and confrelid = 'orders'::regclass
  ) then
    alter table reviews
      add constraint reviews_order_id_fkey
      foreign key (order_id) references orders(id) on delete cascade;
  end if;
end$$;
