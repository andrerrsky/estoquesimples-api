-- 0012 — atendimento de suporte dentro do app.
--
-- Substitui o "mande um e-mail" da tela Sobre por um canal próprio: o app
-- abre uma solicitação, a equipe responde pelo painel e o aparelho recebe
-- um push. Quem não tem conta é identificado pelo install_id (o mesmo da
-- sincronização e do push); quando a pessoa cria conta depois, as
-- solicitações daquela instalação passam a ser dela.
--
-- Estados (do ponto de vista de quem atende):
--   open      aguardando a equipe (nova, ou o usuário escreveu de novo)
--   answered  a equipe respondeu; aguardando o usuário
--   resolved  encerrada (pela equipe ou pelo próprio usuário)

CREATE SEQUENCE support_tickets_number_seq START 1001;

CREATE TABLE support_tickets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Número curto para a pessoa citar ("solicitação #1042").
  number            integer     NOT NULL UNIQUE DEFAULT nextval('support_tickets_number_seq'),
  user_id           uuid        REFERENCES users (id) ON DELETE SET NULL,
  install_id        text        NOT NULL,
  workspace_id      uuid        REFERENCES workspaces (id) ON DELETE SET NULL,
  -- Só para quem não tem conta e quer resposta também por e-mail.
  contact_email     text,
  contact_name      text,
  category          text        NOT NULL DEFAULT 'question',
  subject           text        NOT NULL,
  status            text        NOT NULL DEFAULT 'open',
  priority          text        NOT NULL DEFAULT 'normal',
  -- Modelo, versão do Android e do app, idioma: o que o app sabe de si.
  device            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Estado local no momento da abertura: sessão, empresa, assinatura,
  -- última sincronização, operações pendentes. Diagnóstico, não dado pessoal.
  diagnostics       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  app_version_code  integer,
  assigned_to       uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  assigned_to_email text,
  message_count     integer     NOT NULL DEFAULT 0,
  last_message_at   timestamptz NOT NULL DEFAULT now(),
  last_message_by   text        NOT NULL DEFAULT 'user',
  first_response_at timestamptz,
  resolved_at       timestamptz,
  resolved_by       text,
  -- Última vez que cada lado abriu a conversa, para o "não lido".
  user_seen_at      timestamptz,
  admin_seen_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_status_check   CHECK (status IN ('open', 'answered', 'resolved')),
  CONSTRAINT support_tickets_priority_check CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT support_tickets_category_check
    CHECK (category IN ('question', 'problem', 'suggestion', 'billing', 'account', 'other')),
  CONSTRAINT support_tickets_subject_check  CHECK (length(subject) BETWEEN 1 AND 120),
  CONSTRAINT support_tickets_last_by_check  CHECK (last_message_by IN ('user', 'admin', 'system')),
  CONSTRAINT support_tickets_resolved_by_check CHECK (resolved_by IS NULL OR resolved_by IN ('user', 'admin'))
);

CREATE INDEX support_tickets_queue_idx   ON support_tickets (status, last_message_at DESC);
CREATE INDEX support_tickets_user_idx    ON support_tickets (user_id, last_message_at DESC);
CREATE INDEX support_tickets_install_idx ON support_tickets (install_id, last_message_at DESC);
CREATE INDEX support_tickets_assigned_idx ON support_tickets (assigned_to) WHERE status <> 'resolved';

CREATE TRIGGER support_tickets_set_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE support_messages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid        NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
  author       text        NOT NULL,
  admin_id     uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  -- Nome exibido ao usuário; o e-mail do administrador nunca vai ao app.
  admin_name   text,
  body         text        NOT NULL,
  -- Nota interna: visível só no painel, não dispara notificação.
  internal     boolean     NOT NULL DEFAULT false,
  -- Resultado da notificação ao usuário (push/e-mail) desta resposta.
  notify_status text,
  notify_detail text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_author_check CHECK (author IN ('user', 'admin', 'system')),
  CONSTRAINT support_messages_body_check   CHECK (length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at);

ALTER TABLE support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets  FORCE  ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages FORCE  ROW LEVEL SECURITY;

CREATE POLICY support_tickets_system ON support_tickets
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY support_messages_system ON support_messages
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
