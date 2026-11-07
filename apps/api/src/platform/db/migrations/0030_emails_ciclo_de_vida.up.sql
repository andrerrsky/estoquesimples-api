-- Funil de e-mails do ciclo de vida (ativação, confirmação, reengajamento,
-- limite do plano). Ver apps/api/src/modules/lifecycle.
--
-- Na conta: quem pediu para não receber (descadastro em 1 clique) e
-- endereços que voltaram (bounce permanente) ou foram marcados como spam,
-- informados pelo webhook do Resend. Nenhum dos dois afeta e-mails
-- essenciais (redefinição de senha, convite, verificação).
ALTER TABLE users ADD COLUMN lifecycle_emails_opt_out_at timestamptz;
ALTER TABLE users ADD COLUMN email_suppressed_at timestamptz;

-- Uma linha por e-mail do ciclo de vida decidido (enviado, simulado ou
-- falho). `dedupe_key` impede mandar o mesmo passo duas vezes (por pessoa,
-- ou por empresa nos avisos de limite). O id também é o token do link de
-- descadastro e do clique.
CREATE TABLE lifecycle_emails (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id  uuid        REFERENCES workspaces (id) ON DELETE SET NULL,
  kind          text        NOT NULL,
  dedupe_key    text        NOT NULL UNIQUE,
  status        text        NOT NULL CHECK (status IN ('sent', 'dry_run', 'failed')),
  provider_id   text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  bounced_at    timestamptz,
  complained_at timestamptz,
  unsubscribed_at timestamptz
);
CREATE INDEX lifecycle_emails_user_idx ON lifecycle_emails (user_id, created_at DESC);
CREATE INDEX lifecycle_emails_created_idx ON lifecycle_emails (created_at DESC);
CREATE INDEX lifecycle_emails_provider_idx ON lifecycle_emails (provider_id) WHERE provider_id IS NOT NULL;

-- Quantos e-mails saíram por dia (Brasília) e por tipo, de todos os tipos:
-- é o que protege a cota diária do provedor para os e-mails essenciais.
CREATE TABLE email_send_counts (
  day   date    NOT NULL,
  kind  text    NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
