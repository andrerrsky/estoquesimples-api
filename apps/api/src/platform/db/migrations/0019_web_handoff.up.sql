-- "Abrir na web já conectado": o app pede um código de uso único, abre o
-- navegador com ele e a web o troca por uma sessão própria (cookie httpOnly).
-- Guarda-se só o hash; o código vale 2 minutos e uma única vez.
CREATE TABLE web_handoff_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip inet
);

CREATE INDEX web_handoff_tokens_user_idx ON web_handoff_tokens (user_id);
CREATE INDEX web_handoff_tokens_expires_idx ON web_handoff_tokens (expires_at);
