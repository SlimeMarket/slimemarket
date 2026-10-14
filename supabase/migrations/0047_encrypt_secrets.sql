-- ============================================================================
-- 0047_encrypt_secrets — AES-256-GCM encryption metadata for secret_vault
--
-- Relocated from legacy database/migrations/0002_encrypt_secrets.sql (a
-- parallel migrations dir outside Supabase tooling) during cleanup.
--
-- Idempotency changes vs. the original:
--   * ADD COLUMN / CREATE INDEX already carried IF NOT EXISTS guards (kept).
--   * increment_access_count(): parameter typed TEXT to match the actual
--     schema (secret_vault.ref_id is TEXT in 0001_init.sql, not UUID).
--   * DROPPED the original `INSERT INTO audit_log ... 'database_migration'`
--     row: audit_log.action has a CHECK constraint (0001_init.sql) that does
--     not allow 'database_migration', and a bare INSERT is not idempotent.
--
-- secret_vault and audit_log are created by 0001_init.sql, which always runs
-- before this migration.
-- ============================================================================

-- Add encryption metadata column (algorithm, key_version)
ALTER TABLE secret_vault
ADD COLUMN IF NOT EXISTS encryption_metadata JSONB DEFAULT '{
  "algorithm": "aes-256-gcm",
  "key_version": 1
}'::jsonb;

-- Add access tracking for audit purposes (no-op: column exists since 0001)
ALTER TABLE secret_vault
ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0;

ALTER TABLE secret_vault
ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- Add audit log column for tamper-evident logging
ALTER TABLE secret_vault
ADD COLUMN IF NOT EXISTS access_log JSONB DEFAULT '[]'::jsonb;

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_secret_vault_encryption_metadata
ON secret_vault USING gin (encryption_metadata);

CREATE INDEX IF NOT EXISTS idx_secret_vault_access_count
ON secret_vault (access_count DESC);

CREATE INDEX IF NOT EXISTS idx_secret_vault_last_accessed
ON secret_vault (last_accessed_at DESC);

-- Create function to increment access count atomically.
-- NOTE: ref_id is TEXT in the schema (0001_init.sql), so the parameter is
-- TEXT here (the legacy draft used UUID, which would fail at runtime).
CREATE OR REPLACE FUNCTION increment_access_count(
  p_ref_id TEXT,
  p_owner_id UUID
) RETURNS VOID AS $$
BEGIN
  UPDATE secret_vault
  SET
    access_count = COALESCE(access_count, 0) + 1,
    last_accessed_at = NOW()
  WHERE id IN (
    SELECT id FROM secret_vault
    WHERE ref_id = p_ref_id AND owner_id = p_owner_id
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql;

-- Comments explaining encryption requirement (COMMENT is inherently idempotent)
COMMENT ON COLUMN secret_vault.ciphertext IS
'Encrypted credentials using AES-256-GCM. Must be decrypted using lib/crypto/encryption.ts module.';

COMMENT ON COLUMN secret_vault.encryption_metadata IS
'Metadata about encryption parameters including algorithm and key version for rotation support.';

COMMENT ON TABLE secret_vault IS
'Secure storage for sensitive user data (credentials, API keys, etc.). All data MUST be encrypted before insertion.';
