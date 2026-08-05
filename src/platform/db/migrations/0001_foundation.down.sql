DROP TABLE IF EXISTS app_config;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS email_verification_tokens;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS users;

DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_current_user();
DROP FUNCTION IF EXISTS app_current_workspace();

-- O role app_user é deixado no lugar de propósito: outros bancos do mesmo
-- cluster podem estar usando-o, e removê-lo aqui seria destrutivo.
