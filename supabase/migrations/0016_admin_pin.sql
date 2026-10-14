-- ============================================================================
-- SlimeMarket — 0016_admin_pin: Admin/MM PIN for sensitive action verification.
-- Admin + MM roles use this. Combined with UCW device approval for 2FA.
-- ============================================================================

-- Add admin_pin_hash (scrypt hash, nullable — null means PIN not set yet)
alter table users
  add column if not exists admin_pin_hash text;

-- PIN attempt tracking (3 max before lockout)
alter table users
  add column if not exists pin_attempts int default 0;
alter table users
  add column if not exists pin_locked_until timestamptz;

-- Index for quick admin lookups (small table, but explicit)
create index if not exists idx_users_role_admin on users (id) where role = 'Admin';
