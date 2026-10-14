-- Fix: Grant access to reports table for authenticated users (admin-only via app layer)
-- The reports table exists but has RLS enabled without any policies.

-- Disable RLS on reports table (admin-only access enforced at app layer via requireRole)
ALTER TABLE reports DISABLE ROW LEVEL SECURITY;

-- Grant full access to authenticated role (app layer checks Admin role)
GRANT SELECT, INSERT, UPDATE, DELETE ON reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON reports TO postgres;
