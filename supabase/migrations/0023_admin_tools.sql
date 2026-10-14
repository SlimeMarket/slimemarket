-- ============================================================================
-- 0023_admin_tools — Superadmin toolkit: ban users, freeze products/stores,
-- MM deal reporting. All actions logged to mm_audit_log + audit_log.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users: ban fields
-- ---------------------------------------------------------------------------
alter table users add column if not exists banned boolean not null default false;
alter table users add column if not exists banned_reason text;
alter table users add column if not exists banned_by uuid references users(id) on delete set null;
alter table users add column if not exists banned_until timestamptz;

create index if not exists users_banned_idx on users(banned) where banned = true;

-- ---------------------------------------------------------------------------
-- products: freeze fields
-- ---------------------------------------------------------------------------
alter table products add column if not exists frozen boolean not null default false;
alter table products add column if not exists frozen_reason text;
alter table products add column if not exists frozen_by uuid references users(id) on delete set null;
alter table products add column if not exists frozen_at timestamptz;

create index if not exists products_frozen_idx on products(frozen) where frozen = true;

-- ---------------------------------------------------------------------------
-- stores: freeze fields
-- ---------------------------------------------------------------------------
alter table stores add column if not exists frozen boolean not null default false;
alter table stores add column if not exists frozen_reason text;
alter table stores add column if not exists frozen_by uuid references users(id) on delete set null;
alter table stores add column if not exists frozen_at timestamptz;

create index if not exists stores_frozen_idx on stores(frozen) where frozen = true;

-- ---------------------------------------------------------------------------
-- mm_audit_log: widen action CHECK for ban/freeze/unban/unfreeze/revoke
-- ---------------------------------------------------------------------------
alter table mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table mm_audit_log add constraint mm_audit_log_action_check
  check (action in (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','MM_PROMOTE','MM_DEMOTE',
    'BAN_USER','UNBAN_USER','FREEZE_PRODUCT','UNFREEZE_PRODUCT',
    'FREEZE_STORE','UNFREEZE_STORE','REVOKE_SELLER'
  ));
