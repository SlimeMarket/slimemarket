-- ============================================================================
-- SlimeMarket — 0001_init: core schema (21+ tables).
-- RECOVERED from live schema + ERD.md + API_CONTRACT.md after original file was
-- lost. Money = bigint micro-USDC (6 decimals). NEVER float.
-- Idempotent (create if not exists).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  auth_id         uuid not null unique,
  uid             text not null unique,
  name            text not null,
  handle          text,
  email           text not null unique,
  role            text not null default 'Member' check (role in ('Member','Buyer','Seller','Admin')),
  tx_count        int not null default 0,
  kyc             text not null default 'none' check (kyc in ('none','pending','verified')),
  avatar_url      text,
  avatar_gradient text,
  referral_code   text not null,
  preferred_lang  text not null default 'en' check (preferred_lang in ('en','id','zh')),
  contacts        jsonb not null default '{}'::jsonb,
  joined_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists users_uid_idx on users(uid);
create index if not exists users_role_idx on users(role);

-- ---------------------------------------------------------------------------
-- wallets  (1 per user; Circle MPC address on Arc)
-- ---------------------------------------------------------------------------
create table if not exists wallets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references users(id) on delete cascade,
  address          text not null,
  circle_wallet_id text not null,
  usdc_balance     bigint not null default 0,
  forum_balance    bigint not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- stores
-- ---------------------------------------------------------------------------
create table if not exists stores (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references users(id) on delete cascade,
  name            text not null,
  handle          text,
  uid             text,
  avatar_url      text,
  avatar_gradient text,
  banner_url      text,
  banner_gradient text,
  message         text,
  rating          numeric not null default 0,
  rating_count    int not null default 0,
  joined_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists stores_owner_uniq on stores(owner_user_id);
create index if not exists stores_owner_idx on stores(owner_user_id);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id) on delete cascade,
  name        text not null,
  category    text,
  delivery    text not null check (delivery in ('instant','manual')),
  price       bigint not null,
  variants    jsonb not null default '[]'::jsonb,
  "desc"      text not null,
  notes       text,
  img_url     text,
  gradient    text,
  glyph       text,
  status      text not null default 'active' check (status in ('active','soldout','inactive')),
  stock_items text[] not null default '{}'::text[],
  stock       int not null default 0,
  sold        int not null default 0,
  views       int not null default 0,
  hot         boolean not null default false,
  est         int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_store_idx on products(store_id);
create index if not exists products_category_idx on products(category);
create index if not exists products_status_idx on products(status);

-- ---------------------------------------------------------------------------
-- orders  (marketplace)
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id                  uuid primary key default gen_random_uuid(),
  buyer_id            uuid not null references users(id) on delete cascade,
  store_id            uuid not null references stores(id) on delete cascade,
  product_id          uuid not null references products(id) on delete cascade,
  variant             text,
  qty                 int not null default 1,
  amount              bigint not null,
  circle_fee          bigint not null default 0,
  gas_fee             bigint not null default 0,
  payment             text not null default 'Saldo' check (payment in ('Saldo','Langsung')),
  delivery            text not null check (delivery in ('instant','manual')),
  status              text not null default 'PENDING'
                      check (status in ('PENDING','PROCESS','SENT','DONE','DISPUTED','CANCELLED','DECLINED')),
  credentials_vault_ref text,
  terms               text[] not null default '{}'::text[],
  cancel_reason       text,
  decline_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists orders_buyer_idx on orders(buyer_id);
create index if not exists orders_store_idx on orders(store_id);
create index if not exists orders_status_idx on orders(status);

-- ---------------------------------------------------------------------------
-- wl_listings / wl_deals
-- ---------------------------------------------------------------------------
create table if not exists wl_listings (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null references users(id) on delete cascade,
  project      text not null,
  wl_type      text,
  type         text not null check (type in ('mint','token_transfer','wallet_surrender','discord_surrender','wallet_submit')),
  unit_price   bigint not null default 0,
  mint_price   bigint not null default 0,
  qty          int not null default 1,
  project_link text,
  offer        boolean not null default false,
  collateral   boolean not null default false,
  "desc"       text,
  img_url      text,
  gradient     text,
  glyph        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists wl_listings_seller_idx on wl_listings(seller_id);

create table if not exists wl_deals (
  id                 uuid primary key default gen_random_uuid(),
  listing_id         uuid not null references wl_listings(id) on delete cascade,
  buyer_id           uuid not null references users(id) on delete cascade,
  seller_id          uuid not null references users(id) on delete cascade,
  unit               bigint not null,
  qty                int not null default 1,
  price              bigint not null,
  base_fee           bigint not null default 0,
  total              bigint not null default 0,
  is_offer           boolean not null default false,
  needs_collateral   boolean not null default false,
  seller_collateral  bigint not null default 0,
  buyer_held         boolean not null default false,
  middleman_joined   boolean not null default false,
  status             text not null default 'MENUNGGU'
                     check (status in ('MENUNGGU','ESCROW','SELESAI','BATAL')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists wl_deals_listing_idx on wl_deals(listing_id);
create index if not exists wl_deals_buyer_idx on wl_deals(buyer_id);

-- ---------------------------------------------------------------------------
-- rekber_tx  (generic P2P escrow)
-- ---------------------------------------------------------------------------
create table if not exists rekber_tx (
  id         uuid primary key default gen_random_uuid(),
  buyer_id   uuid references users(id) on delete set null,
  seller_id  uuid references users(id) on delete set null,
  product    text,
  amount     bigint not null default 0,
  payment    text not null default 'Saldo',
  note       text,
  collateral bigint not null default 0,
  status     text not null default 'MENUNGGU'
             check (status in ('MENUNGGU','DISETUJUI','DIKIRIM','SELESAI','DIBATALKAN')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- chat_threads / chat_messages
-- ---------------------------------------------------------------------------
create table if not exists chat_threads (
  id              uuid primary key default gen_random_uuid(),
  participant_ids uuid[] not null default '{}',
  type            text not null default 'normal' check (type in ('normal','escrow')),
  status          text not null default 'active' check (status in ('active','disrupted','closed')),
  order_id        uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references chat_threads(id) on delete cascade,
  sender_id   uuid,
  sender_role text not null default 'system' check (sender_role in ('buyer','seller','middleman','system')),
  text        text not null,
  attachments text[] not null default '{}'::text[],
  reply_to    jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists chat_messages_thread_idx on chat_messages(thread_id, created_at desc);

-- ---------------------------------------------------------------------------
-- tx_groups / ledger_entries  (P0 double-entry. Σ DR = Σ CR per group)
-- ---------------------------------------------------------------------------
create table if not exists tx_groups (
  id         uuid primary key default gen_random_uuid(),
  memo       text,
  created_at timestamptz not null default now()
);

create table if not exists ledger_entries (
  id          uuid primary key default gen_random_uuid(),
  tx_group_id uuid not null references tx_groups(id) on delete cascade,
  account     text not null check (account in ('user_wallet','escrow_holding','platform_fee','seller_payout','referral_payout','gas_pool','collateral_hold')),
  direction   text not null check (direction in ('DR','CR')),
  amount      bigint not null,
  wallet_id   uuid,
  ref_id      text,
  created_at  timestamptz not null default now()
);
create index if not exists ledger_entries_group_idx on ledger_entries(tx_group_id);
create index if not exists ledger_entries_account_idx on ledger_entries(account);
create index if not exists ledger_entries_wallet_idx on ledger_entries(wallet_id);

-- ---------------------------------------------------------------------------
-- reviews
-- ---------------------------------------------------------------------------
create table if not exists reviews (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null unique,
  store_id     uuid not null references stores(id) on delete cascade,
  rating       int not null check (rating between 1 and 5),
  text         text,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists reviews_store_idx on reviews(store_id);

-- ---------------------------------------------------------------------------
-- disputes
-- ---------------------------------------------------------------------------
create table if not exists disputes (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid,
  deal_id       uuid,
  middleman_id  uuid references users(id) on delete set null,
  reason        text,
  evidence      text[] not null default '{}'::text[],
  sla           text,
  outcome       text check (outcome in ('release','refund')),
  note          text,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- seller_applications
-- ---------------------------------------------------------------------------
create table if not exists seller_applications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  store_name  text not null,
  category    text,
  kyc         text not null default 'none',
  note        text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  icon       text not null default 'bell',
  tone       text not null default 'slate',
  title      text not null,
  text       text,
  read       boolean not null default false,
  link       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(user_id, read);

-- ---------------------------------------------------------------------------
-- referrals / referral_events
-- ---------------------------------------------------------------------------
create table if not exists referrals (
  user_id   uuid primary key references users(id) on delete cascade,
  code      text not null unique,
  link      text,
  invited   int not null default 0,
  earned    bigint not null default 0,
  pending   bigint not null default 0,
  tiers     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists referral_events (
  id          uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references users(id) on delete cascade,
  referee_uid text,
  reward      bigint not null default 0,
  status      text not null default 'pending' check (status in ('done','pending')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- secret_vault  (P0 — encrypted secrets)
-- ---------------------------------------------------------------------------
create table if not exists secret_vault (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references users(id) on delete cascade,
  ref_id       text,
  kind         text not null check (kind in ('credential','seed','2fa')),
  ciphertext   text not null,
  access_count int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- audit_log  (append-only)
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references users(id) on delete set null,
  action     text not null check (action in ('RELEASE','REFUND','APPROVE','REJECT','RESOLVE','BAN','FREEZE','TAKEDOWN')),
  ref        text,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- bank_accounts / wallet_txs  (for M1 fiat ramp)
-- ---------------------------------------------------------------------------
create table if not exists bank_accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  bank       text not null,
  number     text not null,                        -- masked
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists wallet_txs (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references wallets(id) on delete cascade,
  type            text not null check (type in ('in','out')),
  label           text not null,
  sub             text,
  amount          bigint not null,                      -- micro-USDC
  status          text not null default 'done'
                  check (status in ('done','escrowed','pending','failed')),
  idempotency_key text unique,
  circle_tx_id    text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists wallet_txs_wallet_idx on wallet_txs(wallet_id, created_at desc);

-- ---------------------------------------------------------------------------
-- webhook_events  (idempotency for Circle webhooks)
-- ---------------------------------------------------------------------------
create table if not exists webhook_events (
  id                    uuid primary key default gen_random_uuid(),
  circle_event_id       text,
  circle_transaction_id text,
  notification_type     text,
  mapped_status         text,
  signature_valid       boolean not null default false,
  dedupe_hash           text unique,                  -- sha256(raw body)
  raw_payload           jsonb,
  processed_at          timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists webhook_events_circle_tx_idx on webhook_events(circle_transaction_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers (applied to all app tables; columns added by 0006 if missing)
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  for t in select unnest(array[
    'users','wallets','stores','products','orders','wl_listings','wl_deals',
    'rekber_tx','chat_threads','chat_messages','reviews','disputes',
    'seller_applications','notifications','referrals','secret_vault',
    'bank_accounts','wallet_txs'
  ])
  loop
    execute format(
      'drop trigger if exists %I_trg on %I; create trigger %I_trg before update on %I for each row execute function set_updated_at();',
      t, t, t, t
    );
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- Realtime: enable for chat, orders, wl_deals, notifications
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'chat_messages','chat_threads','orders','wl_deals','notifications','wallet_txs'
  ])
  loop
    begin
      execute format('alter publication supabase_realtime add table %I;', t);
    exception when duplicate_object then null;
    end;
  end loop;
end$$;
