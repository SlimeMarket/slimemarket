-- ============================================================================
-- SlimeMarket — 0021_remove_kyc: PRIVACY-FIRST KYC REMOVAL
-- 
-- Mission: Remove ALL KYC collection features for privacy-first architecture!
-- No documents collected, no personal data stored, manual seller verification only!
--
-- Changes:
-- 1. DROP users.kyc column (check constraint + default)
-- 2. DROP seller_applications.kyc column (keep other fields for manual review)
-- 3. No documents tables created (privacy-first!)
-- ============================================================================

-- Drop KYC column from users table
ALTER TABLE users 
DROP COLUMN IF EXISTS kyc;

-- Update seller_applications table - remove KYC field but keep approval workflow
ALTER TABLE seller_applications 
DROP COLUMN IF EXISTS kyc;

-- Add comment to document privacy-first approach
COMMENT ON TABLE seller_applications IS 'Manual seller applications - NO KYC documents collected. Privacy-first approval via admin review only.';
