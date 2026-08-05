-- Fase 1: fundação (identidade, sessões, dispositivos, auditoria, jobs).
--
-- Estratégia de isolamento multi-tenant adotada em todo o schema:
-- a aplicação conecta como o dono das tabelas (único usuário que o Railway
-- fornece) mas, a cada requisição de tenant, executa `SET LOCAL ROLE app_user`.
-- O dono ignora RLS por definição no Postgres; o app_user não. Assim as
-- políticas valem para todo tráfego de usuário, e tarefas de sistema
-- (migrations, reconciliação, limpeza) rodam sem trocar de role.

-- ---------------------------------------------------------------------------
-- Role de aplicação e funções auxiliares
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  -- O usuário da conexão precisa ser membro do role para poder assumi-lo.
  EXECUTE format('GRANT app_user TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;

-- Workspace corrente da transação. Retorna NULL quando não definido, o que
-- faz todas as políticas de RLS negarem acesso por padrão.
CREATE OR REPLACE FUNCTION app_current_workspace() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Usuários
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text        NOT NULL,
  password_hash         text        NOT NULL,
  name                  text        NOT NULL,
  email_verified_at     timestamptz,
  -- Incrementado a cada mudança crítica (senha, papel, remoção). Access tokens
  -- que carregam uma versão defasada são rejeitados sem consultar o banco.
  permission_version    integer     NOT NULL DEFAULT 1,
  failed_login_attempts integer     NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  status                text        NOT NULL DEFAULT 'active',
  deletion_requested_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'pending_deletion')),
  CONSTRAINT users_email_format_check CHECK (position('@' IN email) > 1)
);

-- Unicidade case-insensitive, ignorando contas já excluídas para permitir
-- que o mesmo e-mail seja reutilizado após uma exclusão de conta.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Dispositivos
-- ---------------------------------------------------------------------------

CREATE TABLE devices (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Identificador estável gerado pelo app na primeira execução.
  install_id            text        NOT NULL,
  platform              text        NOT NULL DEFAULT 'android',
  model                 text,
  os_version            text,
  app_version_code      integer,
  app_version_name      text,
  sync_protocol_version integer,
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  CONSTRAINT devices_platform_check CHECK (platform IN ('android', 'ios', 'web'))
);

CREATE UNIQUE INDEX devices_user_install_unique ON devices (user_id, install_id);
CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER devices_set_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Sessões e refresh tokens
-- ---------------------------------------------------------------------------

-- Uma sessão representa um login (uma "família" de refresh tokens).
CREATE TABLE sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id      uuid        REFERENCES devices (id) ON DELETE SET NULL,
  user_agent     text,
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT sessions_revoked_reason_check CHECK (
    revoked_reason IS NULL OR revoked_reason IN (
      'logout', 'logout_all', 'password_changed', 'token_reuse_detected',
      'member_removed', 'permission_changed', 'device_revoked', 'account_deleted', 'expired'
    )
  )
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Cada rotação grava uma nova linha. Guardamos apenas o hash: um vazamento do
-- banco não permite forjar um refresh token válido.
CREATE TABLE refresh_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_by uuid        REFERENCES refresh_tokens (id) ON DELETE SET NULL
);

CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Tokens de uso único (recuperação de senha e verificação de e-mail)
-- ---------------------------------------------------------------------------

CREATE TABLE password_reset_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip inet
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE email_verification_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email      text        NOT NULL,
  token_hash text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Auditoria
--
-- workspace_id fica sem chave estrangeira nesta migration porque a tabela
-- workspaces só nasce na Fase 2; a FK é adicionada lá. Eventos de conta
-- (login, troca de senha) não pertencem a workspace algum e mantêm NULL.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           bigserial   PRIMARY KEY,
  workspace_id uuid,
  actor_user_id uuid       REFERENCES users (id) ON DELETE SET NULL,
  actor_device_id uuid     REFERENCES devices (id) ON DELETE SET NULL,
  action       text        NOT NULL,
  entity_type  text,
  entity_id    text,
  -- Metadados mínimos. Nunca senha, token ou purchase token.
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_workspace_idx ON audit_log (workspace_id, created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

-- ---------------------------------------------------------------------------
-- Fila de tarefas
--
-- Uma tabela no próprio Postgres, consumida com FOR UPDATE SKIP LOCKED.
-- Evita adicionar Redis/BullMQ à infraestrutura antes de haver necessidade
-- comprovada; suporta com folga a escala de milhares de workspaces.
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Chave opcional de deduplicação: impede enfileirar a mesma tarefa duas vezes.
  unique_key   text,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0,
  max_attempts integer     NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  completed_at timestamptz,
  failed_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX jobs_unique_key_idx ON jobs (unique_key) WHERE unique_key IS NOT NULL AND completed_at IS NULL;
CREATE INDEX jobs_pending_idx ON jobs (run_at) WHERE completed_at IS NULL AND failed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Configuração dinâmica
--
-- Permite desligar a sincronização remotamente, sem redeploy e sem novo
-- release do aplicativo. É o botão de emergência exigido pelo plano.
-- ---------------------------------------------------------------------------

CREATE TABLE app_config (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES users (id) ON DELETE SET NULL
);
