-- ============================================================================
-- SlimeMarket — 0011_m7_hardening: idempotency + KYC tier.
-- Money = bigint micro-USDC. Idempotent.
-- ============================================================================

-- orders: idempotency_key for checkout deduplication
alter table orders add column if not exists idempotency_key text unique;
create index if not exists orders_idempotency_idx on orders(idempotency_key);

-- wallets: daily_withdraw_limit for KYC tier ($500 unverified, $10K verified)
alter table wallets add column if not exists daily_withdraw_limit bigint not null default 500000000;

-- RPC: check daily withdraw limit
create or replace function check_daily_withdraw_limit(p_user_id uuid, p_amount bigint)
returns void as $$
declare v_limit bigint; v_today bigint; v_role text;
begin
  select w.daily_withdraw_limit, u.role into v_limit, v_role
    from wallets w join users u on u.id = w.user_id where w.user_id = p_user_id;
  if v_role = 'Admin' then return; end if;
  select coalesce(sum(amount),0) into v_today
    from wallet_txs where wallet_id in (select id from wallets where user_id=p_user_id)
     and type='out' and status='done' and created_at>=current_date::timestamptz;
  if (v_today + p_amount) > v_limit then
    raise exception 'daily limit exceeded (limit=%, used=%, req=%)', v_limit, v_today, p_amount;
  end if;
end;
$$ language plpgsql security definer;
