-- 0011 — push notifications (Firebase Cloud Messaging).
--
-- Três tabelas: os tokens dos aparelhos (registrados pelo app, com ou sem
-- conta), as campanhas montadas no painel e uma linha por token em cada
-- campanha, que é onde o funil aceito → entregue → aberto é medido. O FCM
-- só diz que aceitou a mensagem; "entregue" e "aberto" vêm do próprio app,
-- que reporta quando recebe e quando a pessoa toca.

CREATE TABLE push_tokens (
  token                 text        PRIMARY KEY,
  install_id            text        NOT NULL,
  user_id               uuid        REFERENCES users (id) ON DELETE SET NULL,
  device_id             uuid        REFERENCES devices (id) ON DELETE SET NULL,
  platform              text        NOT NULL DEFAULT 'android',
  app_version_code      integer,
  locale                text,
  -- O aparelho diz se as notificações estão permitidas no sistema; sem isso
  -- o FCM aceita a mensagem e ela nunca aparece.
  notifications_enabled boolean,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoke_reason         text,
  CONSTRAINT push_tokens_platform_check CHECK (platform IN ('android', 'ios', 'web'))
);

CREATE INDEX push_tokens_install_idx ON push_tokens (install_id);
CREATE INDEX push_tokens_user_idx    ON push_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX push_tokens_live_idx    ON push_tokens (last_seen_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE push_campaigns (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text        NOT NULL,
  body             text        NOT NULL,
  -- Ação ao tocar: tela do app e/ou URL. Sem dado pessoal.
  action           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Especificação do público (tipo + filtros), resolvida na hora do envio.
  audience         jsonb       NOT NULL,
  audience_label   text        NOT NULL DEFAULT '',
  status           text        NOT NULL DEFAULT 'draft',
  is_test          boolean     NOT NULL DEFAULT false,
  targeted         integer     NOT NULL DEFAULT 0,
  accepted         integer     NOT NULL DEFAULT 0,
  failed           integer     NOT NULL DEFAULT 0,
  delivered        integer     NOT NULL DEFAULT 0,
  opened           integer     NOT NULL DEFAULT 0,
  error            text,
  created_by       uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  created_by_email text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  CONSTRAINT push_campaigns_status_check
    CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT push_campaigns_title_check CHECK (length(title) BETWEEN 1 AND 80),
  CONSTRAINT push_campaigns_body_check  CHECK (length(body) BETWEEN 1 AND 500)
);

CREATE INDEX push_campaigns_time_idx ON push_campaigns (created_at DESC);

CREATE TRIGGER push_campaigns_set_updated_at
  BEFORE UPDATE ON push_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE push_deliveries (
  campaign_id  uuid        NOT NULL REFERENCES push_campaigns (id) ON DELETE CASCADE,
  token        text        NOT NULL,
  install_id   text        NOT NULL,
  user_id      uuid,
  status       text        NOT NULL DEFAULT 'pending',
  error        text,
  accepted_at  timestamptz,
  delivered_at timestamptz,
  opened_at    timestamptz,
  PRIMARY KEY (campaign_id, token),
  CONSTRAINT push_deliveries_status_check
    CHECK (status IN ('pending', 'accepted', 'failed', 'delivered', 'opened'))
);

CREATE INDEX push_deliveries_install_idx ON push_deliveries (campaign_id, install_id);

ALTER TABLE push_tokens     ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens     FORCE  ROW LEVEL SECURITY;
ALTER TABLE push_campaigns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_campaigns  FORCE  ROW LEVEL SECURITY;
ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY push_tokens_system ON push_tokens
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY push_campaigns_system ON push_campaigns
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY push_deliveries_system ON push_deliveries
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
