-- Entrar e criar conta com o Google (web).
--
-- Senha opcional: quem criou a conta com o Google não tem senha (pode criar
-- uma por "Esqueci minha senha"). `signup_method` diz como a conta nasceu
-- (painel e eventos); não muda depois, mesmo que a pessoa vincule o Google a
-- uma conta criada por e-mail.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN signup_method text NOT NULL DEFAULT 'email'
  CONSTRAINT users_signup_method_check CHECK (signup_method IN ('email', 'google'));

-- Contas externas ligadas a uma conta nossa. Uma conta Google liga-se a uma
-- conta só, e cada conta tem no máximo uma conta Google. O e-mail é o que o
-- Google informou na última entrada (só para suporte; quem manda é `users`).
-- Tabela de sistema: sem GRANT para app_user.
CREATE TABLE user_identities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         text        NOT NULL CHECK (provider IN ('google')),
  provider_user_id text        NOT NULL,
  email            text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);
