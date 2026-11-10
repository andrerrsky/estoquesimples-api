ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_web_price_semiannual_check,
  DROP CONSTRAINT IF EXISTS plans_google_offer_check,
  DROP COLUMN IF EXISTS web_price_semiannual_cents,
  DROP COLUMN IF EXISTS google_offer_price_cents,
  DROP COLUMN IF EXISTS google_offer_cycles;
