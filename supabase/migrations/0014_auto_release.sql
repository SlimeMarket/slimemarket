-- ============================================================================
-- SlimeMarket — 0014_auto_release: 42-hour auto-release for marketplace orders
-- ============================================================================

alter table orders
  add column if not exists sent_at          timestamptz,
  add column if not exists release_deadline timestamptz,
  add column if not exists on_chain_order_id text;

create or replace function auto_release_expired_orders()
returns setof orders as $$
  update orders
  set status = 'DONE', updated_at = now()
  where status = 'SENT'
    and release_deadline is not null
    and release_deadline < now()
  returning *;
$$ language sql security definer;
