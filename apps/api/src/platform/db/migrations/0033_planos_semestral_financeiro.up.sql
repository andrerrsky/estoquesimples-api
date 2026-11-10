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

-- Preços da web definidos pelo dono em 10/11/2026: o anual estava com o valor
-- de um mês (16,99) e era cobrado assim, uma vez por ano. Mensal igual ao app,
-- semestral e anual com desconto; oferta de entrada do Google Play (19,99 nos
-- 2 primeiros meses) para o relatório financeiro.
UPDATE plans
   SET web_price_monthly_cents = 2499,
       web_price_semiannual_cents = 12990,
       web_price_yearly_cents = 19990,
       google_offer_price_cents = 1999,
       google_offer_cycles = 2,
       updated_at = now()
 WHERE key = 'basico';
