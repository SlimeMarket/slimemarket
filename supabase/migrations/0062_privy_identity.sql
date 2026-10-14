-- ============================================================================
-- 1 — Privy identity.
--
-- Adds users.privy_did (Privy Decentralized ID) + a partial unique index.
-- Nullable: only Privy-authenticated accounts have a DID; existing Circle UCW
-- accounts are untouched and can link a DID on first Privy login with the
-- same email (the /api/auth/privy-session route backfills it).
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS privy_did text;

CREATE UNIQUE INDEX IF NOT EXISTS users_privy_did_uniq
  ON users (privy_did)
  WHERE privy_did IS NOT NULL;
