-- Segundo fator (TOTP) no painel: segredo cifrado, último passo aceito (contra replay) e códigos de recuperação (hash).
ALTER TABLE platform_admins
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb;
