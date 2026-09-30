-- 0009 — painel administrativo e analytics de produto.
--
-- Duas famílias de tabelas nascem aqui, ambas fora do modelo de tenant:
--
--   * identidade e trilha dos administradores da plataforma (quem opera o
--     painel de suporte), separada de `users` de propósito: uma conta de
--     cliente jamais deve poder virar administrador por um bit trocado, e a
--     sessão do painel tem ciclo de vida, cookie e política próprios;
--   * eventos de uso do produto (analytics), gravados pelo app e pela própria
--     API, que alimentam os indicadores do painel.
--
-- Nenhuma delas recebe GRANT para `app_user`. Elas só são lidas e escritas no
-- contexto de sistema (papel dono, sem workspace na transação), e mesmo assim
-- ganham RLS + FORCE com a política de sistema, seguindo a regra da migration
-- 0007: o critério de acesso é o contexto declarado, nunca "quem sou".

-- ---------------------------------------------------------------------------
-- Administradores da plataforma
-- ---------------------------------------------------------------------------

CREATE TABLE platform_admins (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text        NOT NULL,
  name                  text        NOT NULL,
  password_hash         text        NOT NULL,
  -- owner: tudo, inclusive gerir outros administradores.
  -- support: opera contas (suspender, revogar sessões, reprocessar assinatura).
  -- viewer: só leitura.
  role                  text        NOT NULL DEFAULT 'support',
  status                text        NOT NULL DEFAULT 'active',
  failed_login_attempts integer     NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_by            uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_admins_role_check   CHECK (role IN ('owner', 'support', 'viewer')),
  CONSTRAINT platform_admins_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT platform_admins_email_check  CHECK (position('@' IN email) > 1)
);

CREATE UNIQUE INDEX platform_admins_email_unique ON platform_admins (lower(email));

CREATE TRIGGER platform_admins_set_updated_at
  BEFORE UPDATE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sessão do painel: cookie httpOnly com token opaco; aqui fica só o hash.
CREATE TABLE admin_sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid        NOT NULL REFERENCES platform_admins (id) ON DELETE CASCADE,
  token_hash     text        NOT NULL UNIQUE,
  ip_address     inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text
);

CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id) WHERE revoked_at IS NULL;
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at) WHERE revoked_at IS NULL;

-- Trilha do que os administradores fizeram no painel. Separada de `audit_log`
-- porque responde a outra pergunta ("quem do nosso lado mexeu nesta conta?")
-- e porque o e-mail fica gravado em texto: a linha precisa continuar
-- legível mesmo depois de o administrador ser removido.
CREATE TABLE admin_audit_log (
  id          bigserial   PRIMARY KEY,
  admin_id    uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  admin_email text        NOT NULL,
  action      text        NOT NULL,
  target_type text,
  target_id   text,
  -- Nunca senha, token ou purchase token. Diferenças de campos, motivos, ids.
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_time_idx   ON admin_audit_log (created_at DESC);
CREATE INDEX admin_audit_log_admin_idx  ON admin_audit_log (admin_id, created_at DESC);
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX admin_audit_log_action_idx ON admin_audit_log (action, created_at DESC);

-- Anotações de suporte sobre uma conta ou empresa ("cliente relatou X em
-- tal data"). Ficam com o registro, não num chat perdido.
CREATE TABLE admin_account_notes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid        REFERENCES workspaces (id) ON DELETE CASCADE,
  admin_id     uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  admin_email  text        NOT NULL,
  body         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_account_notes_target_check CHECK (user_id IS NOT NULL OR workspace_id IS NOT NULL),
  CONSTRAINT admin_account_notes_body_check   CHECK (length(btrim(body)) > 0 AND length(body) <= 4000)
);

CREATE INDEX admin_account_notes_user_idx      ON admin_account_notes (user_id, created_at DESC);
CREATE INDEX admin_account_notes_workspace_idx ON admin_account_notes (workspace_id, created_at DESC);

CREATE TRIGGER admin_account_notes_set_updated_at
  BEFORE UPDATE ON admin_account_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Eventos de uso do produto
--
-- Uma linha por evento, sem pré-agregação: o volume previsto (dezenas de
-- eventos por usuário por dia) cabe com folga numa tabela indexada por tempo,
-- e agregar na leitura permite criar métricas novas sem migrar histórico.
-- A retenção é feita por job (ANALYTICS_RETENTION_DAYS).
--
-- `client_event_id` é a chave de idempotência do app: o lote pode ser
-- reenviado depois de uma resposta perdida e a segunda chegada não duplica.
-- ---------------------------------------------------------------------------

CREATE TABLE analytics_events (
  id               bigserial   PRIMARY KEY,
  client_event_id  uuid        UNIQUE,
  name             text        NOT NULL,
  -- Relógio do aparelho (informativo); `received_at` é o do servidor.
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  user_id          uuid        REFERENCES users (id) ON DELETE SET NULL,
  workspace_id     uuid        REFERENCES workspaces (id) ON DELETE SET NULL,
  device_id        uuid        REFERENCES devices (id) ON DELETE SET NULL,
  -- Permite acompanhar o funil antes de existir conta (instalou, abriu,
  -- viu a tela de cadastro).
  install_id       text,
  platform         text        NOT NULL DEFAULT 'android',
  app_version_code integer,
  -- Agrupa eventos de uma mesma abertura do app; gerado pelo cliente.
  session_key      text,
  -- 'app' vem do cliente; 'server' é emitido pela própria API em marcos
  -- do ciclo de vida (cadastro, login, assinatura, sincronização).
  source           text        NOT NULL DEFAULT 'app',
  properties       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT analytics_events_name_check
    CHECK (name ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$' AND length(name) <= 80),
  CONSTRAINT analytics_events_platform_check
    CHECK (platform IN ('android', 'ios', 'web', 'server')),
  CONSTRAINT analytics_events_source_check
    CHECK (source IN ('app', 'server'))
);

CREATE INDEX analytics_events_time_idx      ON analytics_events (occurred_at DESC);
CREATE INDEX analytics_events_name_time_idx ON analytics_events (name, occurred_at DESC);
CREATE INDEX analytics_events_user_idx      ON analytics_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX analytics_events_workspace_idx ON analytics_events (workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX analytics_events_install_idx   ON analytics_events (install_id, occurred_at DESC)
  WHERE install_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Isolamento: só o contexto de sistema enxerga estas tabelas
-- ---------------------------------------------------------------------------

ALTER TABLE platform_admins     ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins     FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions      FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log     FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin_account_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_account_notes FORCE  ROW LEVEL SECURITY;
ALTER TABLE analytics_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events    FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_admins_system ON platform_admins
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY admin_sessions_system ON admin_sessions
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY admin_audit_log_system ON admin_audit_log
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY admin_account_notes_system ON admin_account_notes
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY analytics_events_system ON analytics_events
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

-- Sem GRANT para app_user: nem leitura. Um membro de empresa não tem por que
-- ver quem administra a plataforma nem os eventos de outras empresas.
