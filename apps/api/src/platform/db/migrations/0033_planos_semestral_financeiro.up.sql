-- Plano semestral na web (Asaas cobra a cada 6 meses) e a oferta de entrada
-- do Google Play, usada só para estimar a receita no relatório financeiro.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS web_price_semiannual_cents integer,
  ADD COLUMN IF NOT EXISTS google_offer_price_cents integer,
  ADD COLUMN IF NOT EXISTS google_offer_cycles integer;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_web_price_semiannual_check;
ALTER TABLE plans ADD CONSTRAINT plans_web_price_semiannual_check
  CHECK (web_price_semiannual_cents IS NULL OR web_price_semiannual_cents >= 500);
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_google_offer_check;
ALTER TABLE plans ADD CONSTRAINT plans_google_offer_check
  CHECK ((google_offer_price_cents IS NULL OR google_offer_price_cents >= 0)
     AND (google_offer_cycles IS NULL OR google_offer_cycles BETWEEN 1 AND 24));
