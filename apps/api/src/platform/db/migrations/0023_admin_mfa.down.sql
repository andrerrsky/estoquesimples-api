ALTER TABLE platform_admins
  DROP COLUMN recovery_codes,
  DROP COLUMN totp_last_step,
  DROP COLUMN totp_enabled_at,
  DROP COLUMN totp_secret;
