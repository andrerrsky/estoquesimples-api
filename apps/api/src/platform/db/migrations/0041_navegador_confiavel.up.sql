-- Navegador confiável no painel administrativo.
--
-- O dono do serviço usa dois computadores e digitava o código do
-- autenticador em cada entrada. As sessões simultâneas já eram possíveis
-- (nada no login revoga as outras), mas a sessão morria por inatividade em
-- 12 h e o teto absoluto era de 7 dias: na prática, código novo quase sempre.
--
-- Aqui o navegador é que fica conhecido, não o IP (que muda) nem o
-- User-Agent (que muda a cada atualização do Chrome): um segundo cookie,
-- separado do de sessão, com token opaco de alta entropia guardado só como
-- hash. Ele nasce **apenas** quando um código válido do segundo fator acabou
-- de ser conferido e a pessoa pediu para confiar neste navegador — por isso
-- a tabela não tem como ser criada sem MFA.
--
-- O que ele dispensa é o segundo fator, nunca a senha. Vale por poucos dias,
-- é listável e revogável no painel, e cai junto quando a senha muda, quando o
-- acesso é desativado ou quando o segundo fator é mexido.
CREATE TABLE IF NOT EXISTS admin_trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  -- SHA-256 do token do cookie: um vazamento de banco não vira acesso.
  token_hash text NOT NULL UNIQUE,
  -- Como o painel mostra o navegador na lista ("Chrome no macOS").
  label text,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);

CREATE INDEX IF NOT EXISTS admin_trusted_devices_admin_idx
  ON admin_trusted_devices (admin_id)
  WHERE revoked_at IS NULL;

-- A sessão sabe de que navegador confiável nasceu: revogar o navegador
-- encerra as sessões dele, e é essa marca que autoriza a sessão longa.
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS trusted_device_id uuid
  REFERENCES admin_trusted_devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS admin_sessions_trusted_device_idx
  ON admin_sessions (trusted_device_id)
  WHERE revoked_at IS NULL;
