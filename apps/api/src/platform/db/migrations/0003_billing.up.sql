-- Fase 3: assinatura validada no servidor.

-- ---------------------------------------------------------------------------
-- Planos e recursos
--
-- Modelados como dados desde já, mesmo que hoje exista um único plano sem
-- limites. Quando surgir cobrança por assento ou teto de dispositivos, o
-- caminho será inserir linhas, não caçar números fixos espalhados pelo código.
-- ---------------------------------------------------------------------------

CREATE TABLE plans (
  key                 text        PRIMARY KEY,
  name                text        NOT NULL,
  description         text        NOT NULL DEFAULT '',
  google_product_id   text,
  google_base_plan_id text,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  plan_key    text    NOT NULL REFERENCES plans (key) ON DELETE CASCADE,
  feature_key text    NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  -- NULL significa "sem limite". Um limite só passa a existir quando alguém
  -- decidir conscientemente qual é o número.
  limit_value integer,
  PRIMARY KEY (plan_key, feature_key)
);

INSERT INTO plans (key, name, description, google_product_id, google_base_plan_id) VALUES
  ('gratuito', 'Gratuito', 'Uso local no aparelho, sem sincronização.', NULL, NULL),
  ('basico',   'Básico',   'Sincronização em nuvem e equipe.', 'assinatura', 'plano-basico');

INSERT INTO plan_features (plan_key, feature_key, enabled, limit_value) VALUES
  ('gratuito', 'sync.nuvem',      false, NULL),
  ('gratuito', 'equipe.membros',  false, 1),
  ('basico',   'sync.nuvem',      true,  NULL),
  ('basico',   'equipe.membros',  true,  NULL),
  ('basico',   'sync.dispositivos', true, NULL);

-- ---------------------------------------------------------------------------
-- Assinaturas
--
-- A assinatura é direito do workspace, não do usuário: o proprietário paga e
-- todos os membros sincronizam. Perder a assinatura tira a sincronização de
-- todo mundo e não apaga nenhum dado local de ninguém.
-- ---------------------------------------------------------------------------

CREATE TABLE subscriptions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  purchaser_user_id   uuid        REFERENCES users (id) ON DELETE SET NULL,
  plan_key            text        NOT NULL REFERENCES plans (key) ON DELETE RESTRICT,

  -- Unicidade global e proposital: um mesmo comprovante de compra não pode
  -- destravar duas empresas. Se um token já vinculado chegar de outra conta,
  -- o índice barra a gravação e a API responde 409 com registro de auditoria,
  -- em vez de vincular em silêncio.
  purchase_token      text        NOT NULL UNIQUE,

  google_product_id   text        NOT NULL,
  google_base_plan_id text,
  google_offer_id     text,

  state               text        NOT NULL,
  auto_renewing       boolean     NOT NULL DEFAULT false,
  acknowledged        boolean     NOT NULL DEFAULT false,

  started_at          timestamptz,
  current_period_end  timestamptz,
  grace_until         timestamptz,
  canceled_at         timestamptz,
  cancel_reason       text,

  -- Em upgrade, downgrade ou reassinatura o Google emite um token novo que
  -- aponta para o anterior. Sem seguir essa cadeia, o resultado seria uma
  -- segunda assinatura ativa para a mesma empresa.
  linked_purchase_token text,
  superseded_by       uuid        REFERENCES subscriptions (id) ON DELETE SET NULL,

  latest_notification_type integer,
  last_verified_at    timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_state_check CHECK (state IN (
    'pendente',
    'ativa',
    'carencia',
    'suspensa',
    'cancelada_mas_ativa',
    'expirada',
    'reembolsada',
    'substituida'
  ))
);

-- Uma empresa tem no máximo uma assinatura viva. Estados terminais podem se
-- repetir à vontade, preservando o histórico.
CREATE UNIQUE INDEX subscriptions_one_live_per_workspace
  ON subscriptions (workspace_id)
  WHERE state IN ('pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa');

CREATE INDEX subscriptions_workspace_idx ON subscriptions (workspace_id, created_at DESC);
CREATE INDEX subscriptions_linked_token_idx ON subscriptions (linked_purchase_token)
  WHERE linked_purchase_token IS NOT NULL;

-- Fila da reconciliação diária: assinaturas perto de vencer ou verificadas há
-- muito tempo. Notificação perdida acontece na prática, e sem esta varredura
-- a assinatura ficaria congelada num estado desatualizado.
CREATE INDEX subscriptions_reconcile_idx ON subscriptions (last_verified_at)
  WHERE state IN ('pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa');

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER plans_set_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Notificações do Google (RTDN)
-- ---------------------------------------------------------------------------

CREATE TABLE subscription_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Chave de idempotência. O Pub/Sub garante entrega ao menos uma vez, então
  -- a mesma notificação chega repetida com frequência; o índice único faz o
  -- reprocessamento ser um no-op em vez de uma mudança de estado duplicada.
  notification_id   text        NOT NULL UNIQUE,

  notification_type integer,
  purchase_token    text,
  subscription_id   uuid        REFERENCES subscriptions (id) ON DELETE SET NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  process_error     text
);

CREATE INDEX subscription_events_token_idx ON subscription_events (purchase_token, received_at DESC);
CREATE INDEX subscription_events_pending_idx ON subscription_events (received_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Leitura pelo tenant; escrita apenas pelo contexto de sistema (webhook e job
-- de reconciliação não têm usuário nem workspace no request).
-- ---------------------------------------------------------------------------

GRANT SELECT ON plans, plan_features TO app_user;
GRANT SELECT ON subscriptions TO app_user;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscriptions_tenant_read ON subscriptions
  FOR SELECT
  USING (workspace_id = app_current_workspace());
