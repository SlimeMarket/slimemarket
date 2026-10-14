-- ============================================================================
-- SlimeMarket — 0046_kyc_cleanup_fix.sql
--
-- Purpose: Complete the platform-wide KYC removal and FIX the two bugs in
-- 0021_remove_kyc_privacy.sql:
--
--   Bug A: 0021 ran `COMMENT ON COLUMN users.kyc IS NULL;` and
--          `COMMENT ON COLUMN seller_applications.kyc IS NULL;` AFTER
--          dropping those columns — errors on strict Postgres.
--          => We do NOT issue any COMMENT ON dropped columns here.
--
--   Bug B: 0021's final privacy comment targeted the misspelled table
--          `sellers_applications` instead of the real `seller_applications`.
--          => We comment the CORRECT table (guarded so it never errors).
--
-- This migration is fully IDEMPOTENT: safe to run whether or not 0021
-- already ran (all statements use IF EXISTS / existence guards).
-- Wrapped in a single transaction so partial application is impossible.
--
-- Intentionally NOT touched: `wallets.daily_withdraw_limit` and the
-- `check_daily_withdraw_limit` RPC — the daily limit survives KYC removal
-- as a flat limit.
-- ============================================================================

BEGIN;

-- Remove KYC column from users (no-op if already dropped by 0021).
ALTER TABLE users DROP COLUMN IF EXISTS kyc;

-- Remove KYC column from seller_applications (no-op if already dropped by 0021).
ALTER TABLE seller_applications DROP COLUMN IF EXISTS kyc;

-- Fix 0021's misspelled table comment: document the privacy-first policy on
-- the CORRECT table name, guarded so it is safe and idempotent.
DO $$
BEGIN
  IF to_regclass('public.seller_applications') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON TABLE seller_applications IS 'Manual seller applications - NO KYC documents collected. Privacy-first approval via admin review only.'$c$;
  END IF;
END
$$;

COMMIT;
