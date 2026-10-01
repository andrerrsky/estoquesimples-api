-- 0015 — versão web: segundo provedor de pagamento (Asaas), histórico de
-- cobranças e caixa de notificações.
--
-- A assinatura continua sendo direito da empresa, com no máximo uma viva por
-- vez, e os estados não mudam. O que muda é de onde ela pode vir: Google Play
-- (app Android) ou Asaas (web). As colunas do Google deixam de ser
-- obrigatórias e cada linha passa a dizer qual é o provedor.

-- ---------------------------------------------------------------------------
-- Assinaturas com provedor
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN provider                 text NOT NULL DEFAULT 'google_play',
  ADD COLUMN provider_subscription_id text,
  ADD COLUMN provider_customer_id     text,
  -- MONTHLY | YEARLY (Asaas). No Google o ciclo é do plano base.
  ADD COLUMN billing_cycle            text,
  -- Forma de pagamento escolhida (PIX, BOLETO, CREDIT_CARD, UNDEFINED).
  ADD COLUMN billing_type             text,
  -- Valor contratado, em centavos. Nulo no Google (o preço fica na Play).
  ADD COLUMN price_cents              integer,
  ADD COLUMN next_due_date            date;

ALTER TABLE subscriptions
  ALTER COLUMN purchase_token_hash DROP NOT NULL,
  ALTER COLUMN purchase_token_enc  DROP NOT NULL,
  ALTER COLUMN google_product_id   DROP NOT NULL;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_provider_check CHECK (provider IN ('google_play', 'asaas')),
  ADD CONSTRAINT subscriptions_provider_fields_check CHECK (
    (provider = 'google_play' AND purchase_token_hash IS NOT NULL AND purchase_token_enc IS NOT NULL AND google_product_id IS NOT NULL)
    OR (provider = 'asaas' AND provider_subscription_id IS NOT NULL AND provider_customer_id IS NOT NULL)
  );

CREATE UNIQUE INDEX subscriptions_provider_id_unique
  ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Preço da venda na web. O do app fica no Google Play; este é o que a API
-- usa para criar a assinatura no Asaas. Nulo = ciclo não é vendido na web.
-- ---------------------------------------------------------------------------

ALTER TABLE plans
  ADD COLUMN web_price_monthly_cents integer,
  ADD COLUMN web_price_yearly_cents  integer,
  ADD CONSTRAINT plans_web_price_monthly_check CHECK (web_price_monthly_cents IS NULL OR web_price_monthly_cents >= 500),
  ADD CONSTRAINT plans_web_price_yearly_check  CHECK (web_price_yearly_cents IS NULL OR web_price_yearly_cents >= 500);

-- ---------------------------------------------------------------------------
-- Pagador no provedor. Um por empresa: quem paga é a empresa, representada
-- pelo proprietário. O documento não é guardado inteiro — só o suficiente
-- para a pessoa reconhecer o cadastro ("CPF final 09").
-- ---------------------------------------------------------------------------

CREATE TABLE billing_customers (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider             text        NOT NULL DEFAULT 'asaas',
  provider_customer_id text        NOT NULL,
  name                 text        NOT NULL,
  email                text,
  document_type        text        NOT NULL,
  document_hint        text        NOT NULL,
  created_by           uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_customers_provider_check CHECK (provider IN ('asaas')),
  CONSTRAINT billing_customers_document_type_check CHECK (document_type IN ('CPF', 'CNPJ')),
  CONSTRAINT billing_customers_workspace_unique UNIQUE (workspace_id, provider),
  CONSTRAINT billing_customers_provider_id_unique UNIQUE (provider, provider_customer_id)
);

CREATE TRIGGER billing_customers_set_updated_at
  BEFORE UPDATE ON billing_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Cobranças. Espelho do que o provedor informa (nunca a fonte da verdade):
-- serve ao histórico que o cliente vê na web e ao suporte no painel.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_payments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  subscription_id     uuid        REFERENCES subscriptions (id) ON DELETE SET NULL,
  provider            text        NOT NULL DEFAULT 'asaas',
  provider_payment_id text        NOT NULL,
  -- Estado como o provedor informa (PENDING, RECEIVED, OVERDUE…).
  status              text        NOT NULL,
  billing_type        text,
  value_cents         integer     NOT NULL,
  net_value_cents     integer,
  description         text,
  due_date            date,
  paid_at             timestamptz,
  invoice_url         text,
  receipt_url         text,
  deleted             boolean     NOT NULL DEFAULT false,
  raw                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_payments_provider_check CHECK (provider IN ('asaas')),
  CONSTRAINT billing_payments_provider_id_unique UNIQUE (provider, provider_payment_id)
);

CREATE INDEX billing_payments_workspace_idx    ON billing_payments (workspace_id, due_date DESC);
CREATE INDEX billing_payments_subscription_idx ON billing_payments (subscription_id, due_date DESC);
CREATE INDEX billing_payments_status_idx       ON billing_payments (status, due_date DESC);

CREATE TRIGGER billing_payments_set_updated_at
  BEFORE UPDATE ON billing_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Eventos de webhook: a mesma tabela passa a receber os dois provedores. O
-- `notification_id` continua sendo a chave de idempotência (no Asaas, o id
-- `evt_…` prefixado com `asaas:`).
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_events
  ADD COLUMN provider   text NOT NULL DEFAULT 'google_play',
  ADD COLUMN event_type text,
  ADD COLUMN provider_subscription_id text,
  ADD COLUMN attempts   integer NOT NULL DEFAULT 0;

ALTER TABLE subscription_events
  ADD CONSTRAINT subscription_events_provider_check CHECK (provider IN ('google_play', 'asaas'));

CREATE INDEX subscription_events_provider_sub_idx
  ON subscription_events (provider, provider_subscription_id, received_at DESC)
  WHERE provider_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Caixa de notificações do usuário. É o canal comum a Android e web: a mesma
-- linha vira push no aparelho (FCM) e item da caixa na web. Tipos novos não
-- exigem migration — `type` é livre e `data` carrega o que a tela precisa
-- para abrir o destino.
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid        REFERENCES workspaces (id) ON DELETE CASCADE,
  type         text        NOT NULL,
  title        text        NOT NULL,
  body         text        NOT NULL DEFAULT '',
  data         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Evita repetir o mesmo aviso (ex.: reprocessamento de um webhook).
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_title_check CHECK (length(title) BETWEEN 1 AND 160),
  CONSTRAINT notifications_body_check  CHECK (length(body) <= 1000)
);

CREATE INDEX notifications_user_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Campanhas também caem na caixa de quem tem conta (é como chegam à web).
ALTER TABLE push_campaigns ADD COLUMN inbox_count integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- RLS: tudo aqui é lido e escrito pelo contexto de sistema; as rotas filtram
-- por empresa/usuário depois de autorizar (mesmo padrão de push e suporte).
-- ---------------------------------------------------------------------------

ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments  FORCE  ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     FORCE  ROW LEVEL SECURITY;

CREATE POLICY billing_customers_system ON billing_customers
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY billing_payments_system ON billing_payments
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY notifications_system ON notifications
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
