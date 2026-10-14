-- supabase/migrations/0045_multi_currency_support.sql
-- Enable multi-currency support with exchange rate tracking

CREATE TABLE IF NOT EXISTS currency_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency VARCHAR(10) NOT NULL,
  quote_currency VARCHAR(10) NOT NULL,
  rate DECIMAL(20, 8) NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(base_currency, quote_currency)
);

CREATE INDEX idx_currency_rates_updated ON currency_rates(last_updated DESC);

-- Create table for currency preferences
CREATE TABLE IF NOT EXISTS user_currency_preferences (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  preferred_currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  show_crypto_prices BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Function to update currency rates (call via cron)
CREATE OR REPLACE FUNCTION update_currency_rates()
RETURNS VOID AS $$
BEGIN
  -- This would be called by a scheduled job
  -- For now, insert sample rates
  INSERT INTO currency_rates (base_currency, quote_currency, rate) VALUES
    ('USD', 'EUR', 0.92),
    ('USD', 'ETH', 2800.0),
    ('USD', 'ARC', 1.5)
  ON CONFLICT (base_currency, quote_currency) DO UPDATE
    SET rate = EXCHANGE.rate, last_updated = NOW();
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT ON currency_rates TO authenticated;
GRANT ALL ON user_currency_preferences TO authenticated;
