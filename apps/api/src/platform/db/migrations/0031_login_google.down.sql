DROP TABLE IF EXISTS user_identities;
ALTER TABLE users DROP COLUMN IF EXISTS signup_method;
-- password_hash continua opcional: voltar a NOT NULL falharia com contas criadas pelo Google.
