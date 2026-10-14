-- ============================================================================
-- 0039_restock_rpcs — helper RPCs for product restocking.
-- ============================================================================

-- Append items to legacy stock_items text[] array (backward compat)
create or replace function append_stock_items(p_product_id uuid, p_items text[])
returns void as $$
begin
  update products set stock_items = array_cat(coalesce(stock_items, '{}'::text[]), p_items)
  where id = p_product_id;
end;
$$ language plpgsql security definer;

grant execute on function append_stock_items to service_role;
grant execute on function append_stock_items to postgres;

-- Increment stock for manual delivery products
create or replace function increment_stock(p_product_id uuid, p_amount int)
returns void as $$
begin
  update products set stock = coalesce(stock, 0) + p_amount
  where id = p_product_id;
end;
$$ language plpgsql security definer;

grant execute on function increment_stock to service_role;
grant execute on function increment_stock to postgres;

-- Update variants jsonb on an existing product
create or replace function update_product_variants(p_product_id uuid, p_variants jsonb)
returns void as $$
begin
  update products set variants = p_variants where id = p_product_id;
end;
$$ language plpgsql security definer;

grant execute on function update_product_variants to service_role;
grant execute on function update_product_variants to postgres;
