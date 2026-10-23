-- Registro de erros de produção (API, web, web app, app Android e painel).
-- A API grava os 5xx que ela mesma responde; os clientes mandam exceções,
-- falhas de rede inesperadas e respostas 5xx por POST /v1/client-errors. O
-- painel agrupa pela impressão digital (mesma origem, código, mensagem e
-- primeira linha da pilha) e mostra as ocorrências. Guardado por 30 dias.
-- Nunca guarda corpo de requisição, senha ou token: só o que está abaixo.
CREATE TABLE error_events (
  id             bigserial   PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  received_at    timestamptz NOT NULL DEFAULT now(),
  source         text        NOT NULL CHECK (source IN ('api', 'web', 'android', 'admin')),
  level          text        NOT NULL DEFAULT 'error' CHECK (level IN ('error', 'warning', 'fatal')),
  kind           text        NOT NULL,
  fingerprint    text        NOT NULL,
  code           text,
  message        text        NOT NULL,
  stack          text,
  http_method    text,
  route          text,
  status         integer,
  correlation_id text,
  user_id        uuid,
  workspace_id   uuid,
  device_id      uuid,
  app_version    text,
  platform       text,
  user_agent     text,
  context        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX error_events_fingerprint_idx ON error_events (fingerprint, occurred_at DESC);
CREATE INDEX error_events_occurred_idx ON error_events (occurred_at DESC);
CREATE INDEX error_events_correlation_idx ON error_events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX error_events_user_idx ON error_events (user_id, occurred_at DESC) WHERE user_id IS NOT NULL;
