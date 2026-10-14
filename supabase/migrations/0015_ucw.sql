-- ============================================================================
-- SlimeMarket — 0015_ucw: UCW migration (drop PIN cols, add UCW cols)
-- Idempotent (add/drop column if exists).
-- ============================================================================

-- Drop PIN/2FA columns (replaced by Circle UCW built-in PIN + biometric)
alter table users
  drop column if exists pin_hash,
  drop column if exists pin_attempts,
  drop column if exists pin_locked_until,
  drop column if exists totp_secret,
  drop column if exists totp_enabled,
  drop column if exists pin_reset_token,
  drop column if exists pin_reset_expiry,
  drop column if exists sessions_invalidated_at,
  drop column if exists totp_backup_codes;

-- Add UCW columns (email uniqueness enforced by Circle, not Supabase)
alter table users
  add column if not exists circle_user_id text;

-- Wallet type tracking (dcw or ucw)
alter table wallets
  add column if not exists wallet_type text default 'dcw';

-- Drop Supabase auth columns (no longer needed — auth handled by Circle UCW)
alter table users
  drop column if exists auth_id cascade;

-- Email no longer needs to be unique for auth 
-- (keep it as reference field, uniqueness = Circle)
alter table users
  drop constraint if exists users_email_unique;
