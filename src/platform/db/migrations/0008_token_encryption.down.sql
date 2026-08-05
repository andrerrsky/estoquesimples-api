-- Reverte 0008. Tokens voltam a texto claro a partir do envelope v0:/v1:.
-- Blobs v1: não são decifrados aqui (exigiria a chave da aplicação); ficam
-- como estavam no ciphertext — use só em desenvolvimento antes do deploy.

ALTER TABLE subscriptions
  ADD COLUMN purchase_token text,
  ADD COLUMN linked_purchase_token text;

UPDATE subscriptions
SET
  purchase_token = CASE
    WHEN purchase_token_enc LIKE 'v0:%' THEN substr(purchase_token_enc, 4)
    ELSE purchase_token_enc
  END,
  linked_purchase_token = CASE
    WHEN linked_purchase_token_enc IS NULL THEN NULL
    WHEN linked_purchase_token_enc LIKE 'v0:%' THEN substr(linked_purchase_token_enc, 4)
    ELSE linked_purchase_token_enc
  END;

ALTER TABLE subscriptions
  ALTER COLUMN purchase_token SET NOT NULL;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_purchase_token_hash_key;
DROP INDEX IF EXISTS subscriptions_linked_token_hash_idx;

ALTER TABLE subscriptions
  DROP COLUMN purchase_token_hash,
  DROP COLUMN purchase_token_enc,
  DROP COLUMN linked_purchase_token_hash,
  DROP COLUMN linked_purchase_token_enc;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_purchase_token_key UNIQUE (purchase_token);

CREATE INDEX subscriptions_linked_token_idx
  ON subscriptions (linked_purchase_token)
  WHERE linked_purchase_token IS NOT NULL;

ALTER TABLE subscription_events ADD COLUMN purchase_token text;

UPDATE subscription_events
SET purchase_token = CASE
  WHEN purchase_token_enc IS NULL THEN NULL
  WHEN purchase_token_enc LIKE 'v0:%' THEN substr(purchase_token_enc, 4)
  ELSE purchase_token_enc
END;

DROP INDEX IF EXISTS subscription_events_token_hash_idx;

ALTER TABLE subscription_events
  DROP COLUMN purchase_token_hash,
  DROP COLUMN purchase_token_enc;

CREATE INDEX subscription_events_token_idx
  ON subscription_events (purchase_token, received_at DESC);

REVOKE ALL ON subscriptions FROM app_user;
GRANT SELECT ON subscriptions TO app_user;
