-- ============================================================================
-- SlimeMarket — 0003_functions: server-side RPC enforcing golden rules.
-- All financial & state mutations go through these (called with service role).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- pop_stock_fifo(p_product_id uuid, p_qty int)
--   Atomic FIFO pop from products.stock_items. Row-locks the product.
--   Returns a JSONB: { items: text[], remaining: int, status: text }
--   Sets product.status='soldout' if remaining == 0.
--   Throws if insufficient stock or product is not instant.
--   Callers wrap in their own tx group + ledger entry.
-- ---------------------------------------------------------------------------
create or replace function pop_stock_fifo(p_product_id uuid, p_qty int)
returns jsonb as $$
declare
  v_delivery  text;
  v_items     text[];
  v_popped    text[];
  v_remaining int;
  v_status    text;
begin
  if p_qty is null or p_qty < 1 then
    raise exception 'qty must be >= 1';
  end if;

  -- Lock the product row for the duration of this transaction.
  select delivery, stock_items, status
    into v_delivery, v_items, v_status
    from products
    where id = p_product_id
    for update;

  if not found then
    raise exception 'product not found: %', p_product_id;
  end if;

  if v_delivery <> 'instant' then
    raise exception 'pop_stock_fifo: product is not instant delivery';
  end if;

  if coalesce(array_length(v_items, 1), 0) < p_qty then
    raise exception 'insufficient stock (have %, want %)',
      coalesce(array_length(v_items, 1), 0), p_qty;
  end if;

  -- FIFO: take from the front.
  v_popped   := v_items[1:p_qty];
  v_items    := case when array_length(v_items, 1) > p_qty
                     then v_items[p_qty+1:]
                     else '{}'::text[] end;
  v_remaining := coalesce(array_length(v_items, 1), 0);

  if v_remaining = 0 then
    v_status := 'soldout';
  end if;

  update products
    set stock_items = v_items,
        status      = v_status,
        sold        = products.sold + p_qty
    where id = p_product_id;

  return jsonb_build_object(
    'items',     to_jsonb(v_popped),
    'remaining', v_remaining,
    'status',    v_status
  );
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- ledger_post(p_entries jsonb)
--   Atomic double-entry post. p_entries = array of:
--     { account, direction, amount, wallet_id?, ref_id? }
--   Creates a tx_group, inserts all entries, asserts Σ DR = Σ CR.
--   Returns tx_group_id (uuid). Raises on imbalance.
-- ---------------------------------------------------------------------------
create or replace function ledger_post(p_entries jsonb)
returns uuid as $$
declare
  v_group_id uuid := gen_random_uuid();
  v_entry    jsonb;
  v_sum_dr   bigint := 0;
  v_sum_cr   bigint := 0;
  v_account  text;
  v_dir      text;
  v_amount   bigint;
  v_wallet   uuid;
  v_ref      text;
begin
  if jsonb_array_length(p_entries) = 0 then
    raise exception 'ledger_post: empty entries';
  end if;

  insert into tx_groups (id, memo)
    values (v_group_id, 'ledger_post')
    on conflict (id) do nothing;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    v_account := v_entry->>'account';
    v_dir     := v_entry->>'direction';
    v_amount  := (v_entry->>'amount')::bigint;
    v_wallet  := nullif(v_entry->>'wallet_id', '')::uuid;
    v_ref     := v_entry->>'ref_id';

    if v_account is null or v_dir not in ('DR','CR') or v_amount is null or v_amount < 0 then
      raise exception 'ledger_post: malformed entry: %', v_entry;
    end if;

    insert into ledger_entries (tx_group_id, account, direction, amount, wallet_id, ref_id)
      values (v_group_id, v_account, v_dir, v_amount, v_wallet, v_ref);

    if v_dir = 'DR' then v_sum_dr := v_sum_dr + v_amount;
    else                 v_sum_cr := v_sum_cr + v_amount;
    end if;
  end loop;

  if v_sum_dr <> v_sum_cr then
    raise exception 'ledger imbalance: DR=% CR=%', v_sum_dr, v_sum_cr;
  end if;

  return v_group_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- promote_role_if_eligible(p_user_id uuid)
--   If user is Member and tx_count >= 3, promote to Buyer. Idempotent.
--   Returns the (possibly updated) role.
-- ---------------------------------------------------------------------------
create or replace function promote_role_if_eligible(p_user_id uuid)
returns text as $$
declare
  v_role    text;
  v_count   int;
begin
  select role, tx_count into v_role, v_count from users where id = p_user_id for update;
  if not found then raise exception 'user not found'; end if;

  if v_role = 'Member' and v_count >= 3 then
    update users set role = 'Buyer' where id = p_user_id;
    return 'Buyer';
  end if;
  return v_role;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- create_user_profile(p_auth_id uuid, p_email text, p_name text,
--                     p_uid text, p_referral_code text, p_preferred_lang text)
--   Insert a users row linked to a Supabase Auth id. Called from /auth/signup
--   AFTER Circle DCW provisioning succeeds. Idempotent on (auth_id) via ON CONFLICT.
--   Returns the user row.
-- ---------------------------------------------------------------------------
create or replace function create_user_profile(
  p_auth_id       uuid,
  p_email         text,
  p_name          text,
  p_uid           text,
  p_referral_code text,
  p_preferred_lang text default 'en'
) returns uuid as $$
declare v_id uuid;
begin
  insert into users (auth_id, email, name, uid, referral_code, preferred_lang)
    values (p_auth_id, p_email, p_name, p_uid, p_referral_code, p_preferred_lang)
    on conflict (auth_id) do nothing
    returning id into v_id;

  if v_id is null then
    select id into v_id from users where auth_id = p_auth_id;
  end if;

  -- seed referral row
  insert into referrals (user_id, code, link, tiers)
    values (v_id, p_referral_code,
            'https://slimemarket.xyz/r/' || p_referral_code,
            jsonb_build_object('perSignup','1.00 USDC','perReferralTx','0.5%'))
    on conflict (user_id) do nothing;

  return v_id;
end;
$$ language plpgsql security definer;

-- ---------------------------------------------------------------------------
-- ensure_store_for_user(p_user_id uuid, p_name text, p_handle text, p_uid text)
--   Create a store row for a seller. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function ensure_store_for_user(
  p_user_id uuid, p_name text, p_handle text, p_uid text
) returns uuid as $$
declare v_id uuid;
begin
  insert into stores (owner_user_id, name, handle, uid)
    values (p_user_id, p_name, p_handle, p_uid)
    on conflict (owner_user_id) do nothing
    returning id into v_id;
  if v_id is null then
    select id into v_id from stores where owner_user_id = p_user_id;
  end if;
  return v_id;
end;
$$ language plpgsql security definer;
