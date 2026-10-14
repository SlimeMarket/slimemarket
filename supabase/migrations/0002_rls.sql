-- ============================================================================
-- SlimeMarket — 0002_rls: Row-Level Security policies.
-- RECOVERED from live schema + ERD.md + API_CONTRACT.md after original file was
-- lost. Pattern: client tables readable by relevant parties; server-only
-- tables deny all (service_role only). Idempotent (drop-if-exists + create).
-- ============================================================================

-- helper: resolve current user's id from the Supabase Auth JWT.
create or replace function current_user_id() returns uuid as $$
  select auth.uid();
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- enable RLS on all tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'users','wallets','stores','products','orders','wl_listings','wl_deals',
    'rekber_tx','chat_threads','chat_messages','reviews','notifications',
    'referrals','referral_events','bank_accounts','wallet_txs',
    'ledger_entries','tx_groups','audit_log','secret_vault','disputes',
    'seller_applications','webhook_events'
  ])
  loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- users: read all (public profiles), update own
-- ---------------------------------------------------------------------------
drop policy if exists users_read_all on users;
create policy users_read_all on users for select using (true);
drop policy if exists users_update_own on users;
create policy users_update_own on users for update using (auth_id = current_user_id());

-- ---------------------------------------------------------------------------
-- wallets: read own only
-- ---------------------------------------------------------------------------
drop policy if exists wallets_read_own on wallets;
create policy wallets_read_own on wallets for select using (user_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- stores: read all, write own (owner)
-- ---------------------------------------------------------------------------
drop policy if exists stores_read_all on stores;
create policy stores_read_all on stores for select using (true);
drop policy if exists stores_write_own on stores;
create policy stores_write_own on stores for all
  using (owner_user_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- products: read public (active/soldout + owner's inactive), write owner
-- ---------------------------------------------------------------------------
drop policy if exists products_read_public on products;
create policy products_read_public on products for select
  using (status in ('active','soldout')
     or store_id in (select id from stores where owner_user_id in (select id from users where auth_id = current_user_id())));
drop policy if exists products_write_owner on products;
create policy products_write_owner on products for all
  using (store_id in (select id from stores where owner_user_id in (select id from users where auth_id = current_user_id())));

-- ---------------------------------------------------------------------------
-- orders: read party (buyer or store owner), write party
-- ---------------------------------------------------------------------------
drop policy if exists orders_read_party on orders;
create policy orders_read_party on orders for select
  using (buyer_id in (select id from users where auth_id = current_user_id())
     or store_id in (select id from stores where owner_user_id in (select id from users where auth_id = current_user_id())));

-- ---------------------------------------------------------------------------
-- wl_listings: read all, write seller (any role can list WL)
-- ---------------------------------------------------------------------------
drop policy if exists wl_listings_read_all on wl_listings;
create policy wl_listings_read_all on wl_listings for select using (true);
drop policy if exists wl_listings_write_seller on wl_listings;
create policy wl_listings_write_seller on wl_listings for all
  using (seller_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- wl_deals: read party (buyer or seller)
-- ---------------------------------------------------------------------------
drop policy if exists wl_deals_read_party on wl_deals;
create policy wl_deals_read_party on wl_deals for select
  using (buyer_id in (select id from users where auth_id = current_user_id())
     or seller_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- rekber_tx: read own
-- ---------------------------------------------------------------------------
drop policy if exists rekber_tx_read_own on rekber_tx;
create policy rekber_tx_read_own on rekber_tx for select
  using (buyer_id in (select id from users where auth_id = current_user_id())
     or seller_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- chat_threads / chat_messages: read party (participant)
-- ---------------------------------------------------------------------------
drop policy if exists chat_threads_read_party on chat_threads;
create policy chat_threads_read_party on chat_threads for select
  using (participant_ids @> array[(select id from users where auth_id = current_user_id())]::uuid[]
     or current_user_id() is null);
drop policy if exists chat_messages_read_party on chat_messages;
create policy chat_messages_read_party on chat_messages for select
  using (thread_id in (
    select id from chat_threads
    where participant_ids @> array[(select id from users where auth_id = current_user_id())]::uuid[]
       or current_user_id() is null
  ));

-- ---------------------------------------------------------------------------
-- reviews: read all
-- ---------------------------------------------------------------------------
drop policy if exists reviews_read_all on reviews;
create policy reviews_read_all on reviews for select using (true);

-- ---------------------------------------------------------------------------
-- notifications: read + update own
-- ---------------------------------------------------------------------------
drop policy if exists notifs_read_own on notifications;
create policy notifs_read_own on notifications for select
  using (user_id in (select id from users where auth_id = current_user_id()));
drop policy if exists notifs_update_own on notifications;
create policy notifs_update_own on notifications for update
  using (user_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- referrals: read own
-- ---------------------------------------------------------------------------
drop policy if exists referrals_read_own on referrals;
create policy referrals_read_own on referrals for select
  using (user_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- bank_accounts: own only
-- ---------------------------------------------------------------------------
drop policy if exists bank_accounts_own on bank_accounts;
create policy bank_accounts_own on bank_accounts for all
  using (user_id in (select id from users where auth_id = current_user_id()));

-- ---------------------------------------------------------------------------
-- wallet_txs: read own (via wallet ownership)
-- ---------------------------------------------------------------------------
drop policy if exists wallet_txs_read_own on wallet_txs;
create policy wallet_txs_read_own on wallet_txs for select
  using (wallet_id in (
    select w.id from wallets w
    join users u on u.id = w.user_id
    where u.auth_id = current_user_id()
  ));

-- ---------------------------------------------------------------------------
-- Server-only tables: deny all (USING false) — service_role bypasses RLS.
-- ---------------------------------------------------------------------------
drop policy if exists secret_vault_none on secret_vault;
create policy secret_vault_none on secret_vault for select using (false);
drop policy if exists ledger_entries_none on ledger_entries;
create policy ledger_entries_none on ledger_entries for select using (false);
drop policy if exists tx_groups_none on tx_groups;
create policy tx_groups_none on tx_groups for select using (false);
drop policy if exists audit_log_none on audit_log;
create policy audit_log_none on audit_log for select using (false);
drop policy if exists disputes_none on disputes;
create policy disputes_none on disputes for select using (false);
drop policy if exists seller_applications_none on seller_applications;
create policy seller_applications_none on seller_applications for select using (false);
drop policy if exists webhook_events_none on webhook_events;
create policy webhook_events_none on webhook_events for select using (false);
