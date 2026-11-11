-- Cupons promocionais da assinatura pela web (Black Friday 2026:
-- docs/black-friday-2026.md). Tabelas de sistema, como billing_customers e
-- billing_payments: sem GRANT para app_user, lidas só pelos caminhos da API
-- que já rodam fora de withTenant.

-- ---------------------------------------------------------------------------
-- Cupom: código, vigência e preços promocionais. O preço cheio não fica aqui:
-- é sempre o da tabela `plans` no momento (a âncora é o preço real vigente).
-- ---------------------------------------------------------------------------

CREATE TABLE coupons (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text        NOT NULL,
  label                text        NOT NULL,
  starts_at            timestamptz NOT NULL,
  -- Inclusivo: o cupom vale até este instante (23:59:59 do último dia).
  ends_at              timestamptz NOT NULL,
  active               boolean     NOT NULL DEFAULT true,
  -- Total do 1º ano com desconto. Nulo = anual fora da oferta.
  yearly_price_cents   integer,
  -- Valor de cada mensalidade promocional. Nulo = mensal fora da oferta.
  monthly_first_cents  integer,
  -- Quantas mensalidades saem pelo valor promocional (o anual é sempre 1 ciclo).
  monthly_promo_cycles integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_code_format_check CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT coupons_period_check CHECK (ends_at > starts_at),
  -- O Asaas não cobra menos de R$ 5,00.
  CONSTRAINT coupons_yearly_price_check CHECK (yearly_price_cents IS NULL OR yearly_price_cents >= 500),
  CONSTRAINT coupons_monthly_price_check CHECK (monthly_first_cents IS NULL OR monthly_first_cents >= 500),
  CONSTRAINT coupons_monthly_cycles_check CHECK (monthly_promo_cycles BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX coupons_code_unique ON coupons (code);
CREATE INDEX coupons_period_idx ON coupons (starts_at, ends_at) WHERE active;

CREATE TRIGGER coupons_set_updated_at
  BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Resgates. Nasce `reservado` no checkout e vira `resgatado` quando a 1ª
-- cobrança é paga: uma tentativa abandonada não queima o cupom. Os únicos
-- parciais garantem 1 resgate por empresa e 1 por CPF/CNPJ em cada cupom.
--
-- `document_hash` = SHA-256 (hex) do documento só com dígitos. O documento
-- inteiro não é guardado em lugar nenhum (billing_customers só tem o final).
-- A empresa excluída não apaga o resgate (o limite por documento continua).
-- ---------------------------------------------------------------------------

CREATE TABLE coupon_redemptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id       uuid        NOT NULL REFERENCES coupons (id) ON DELETE RESTRICT,
  workspace_id    uuid        REFERENCES workspaces (id) ON DELETE SET NULL,
  subscription_id uuid        REFERENCES subscriptions (id) ON DELETE SET NULL,
  document_hash   text        NOT NULL,
  state           text        NOT NULL DEFAULT 'reservado',
  cycle           text        NOT NULL,
  value_cents     integer     NOT NULL,
  redeemed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupon_redemptions_state_check CHECK (state IN ('reservado', 'resgatado')),
  CONSTRAINT coupon_redemptions_cycle_check CHECK (cycle IN ('MONTHLY', 'YEARLY')),
  CONSTRAINT coupon_redemptions_hash_check CHECK (document_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX coupon_redemptions_one_per_workspace
  ON coupon_redemptions (coupon_id, workspace_id) WHERE state = 'resgatado';
CREATE UNIQUE INDEX coupon_redemptions_one_per_document
  ON coupon_redemptions (coupon_id, document_hash) WHERE state = 'resgatado';
CREATE UNIQUE INDEX coupon_redemptions_subscription_unique
  ON coupon_redemptions (subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX coupon_redemptions_workspace_idx ON coupon_redemptions (workspace_id);

CREATE TRIGGER coupon_redemptions_set_updated_at
  BEFORE UPDATE ON coupon_redemptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Assinatura com cupom. `promo_restored_at` marca que o valor no Asaas já
-- voltou ao preço cheio (idempotência da restauração). Sem GRANT para
-- app_user, como price_cents e raw.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN coupon_id         uuid REFERENCES coupons (id) ON DELETE SET NULL,
  ADD COLUMN promo_restored_at timestamptz;

CREATE INDEX subscriptions_coupon_idx ON subscriptions (coupon_id) WHERE coupon_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Black Friday 2026 (aprovada em 11/11/2026): 20/11 00:00 a 01/12 23:59:59,
-- horário de Brasília. Anual R$ 119,90; mensal com o 1º mês a R$ 12,49.
-- ---------------------------------------------------------------------------

INSERT INTO coupons (code, label, starts_at, ends_at, yearly_price_cents, monthly_first_cents, monthly_promo_cycles)
VALUES (
  'BF26',
  'Black Friday',
  timestamptz '2026-11-20 00:00:00 America/Sao_Paulo',
  timestamptz '2026-12-01 23:59:59 America/Sao_Paulo',
  11990,
  1249,
  1
)
ON CONFLICT (code) DO NOTHING;
