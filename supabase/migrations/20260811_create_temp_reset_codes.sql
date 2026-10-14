-- Migration: Create temporary reset codes table for PIN recovery
-- Date: 2026-08-11 (v4 - updated from 6-digit to salted SHA-256 hash)

CREATE TABLE IF NOT EXISTS temp_reset_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL CHECK (length(code) > 0),
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > NOW()),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Index for fast lookup by code
    UNIQUE(code)
);

-- Separate INDEX statement for PostgreSQL compatibility
CREATE INDEX IF NOT EXISTS idx_temp_reset_codes_expires ON temp_reset_codes(expires_at);

-- Create function to automatically clean up expired codes every hour
CREATE OR REPLACE FUNCTION cleanup_expired_reset_codes()
RETURNS void AS $$
BEGIN
    DELETE FROM temp_reset_codes WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup cron job (run every hour via Vercel Cron or similar)
/* Uncomment when setting up production cron:
SELECT crons.create_cron(
  'cleanup-reset-codes',
  '0 * * * *',  -- Every hour at minute 0
  'SELECT cleanup_expired_reset_codes()'
);
*/

COMMENT ON TABLE temp_reset_codes IS 'Temporary storage for PIN reset codes (expire after 10 minutes). Supports 6-digit numeric or salted SHA-256 hash formats.';
COMMENT ON COLUMN temp_reset_codes.code IS 'Reset code (either 6-digit numeric or salt:SHA-256-hash)';
COMMENT ON COLUMN temp_reset_codes.expires_at IS 'Code expiration timestamp (auto-cleaned hourly)';
