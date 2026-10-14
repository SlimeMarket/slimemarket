-- ============================================================================
-- remove the hardcoded seeded admin account.
--
-- Migration 0009_wl_m4.sql seeds a DEV-ONLY Supabase Auth user
-- `admin@mvp.local` with the literal password `Admin123!` plus a
-- public.users row with role='Admin' (uid 'ADMINTEST'). That row would be
-- created by a fresh `supabase db push` into the cloud project: a publicly
-- known credential on an Admin-role account = standing backdoor the moment
-- anyone wires Supabase Auth back in.
--
-- Nothing in the app (routes, e2e, scripts) references that account — our
-- login is Circle-UCW email OTP, and `mvp.local` cannot receive mail, so the
-- account is inert. Chain is intentionally NOT rewritten (0009 stays as the
-- historical record); this migration cleans the rows it created.
-- Idempotent: safe to run on databases that never had the seed.
-- ============================================================================

-- public.users (dependent rows — wallets/referrals/stores/orders — all cascade)
DELETE FROM public.users
 WHERE email = 'admin@mvp.local'
    OR uid = 'ADMINTEST';

-- auth.users row (only if the auth schema exists in this environment)
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DELETE FROM auth.users WHERE email = 'admin@mvp.local';
  END IF;
END $$;
