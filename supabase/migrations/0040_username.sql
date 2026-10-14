-- Add username column (unique, user-selectable)
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;

-- Backfill: set username = handle for existing users (handle is @name lowercase)
UPDATE users SET username = handle WHERE username IS NULL AND handle IS NOT NULL;
