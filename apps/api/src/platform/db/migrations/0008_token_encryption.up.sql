-- 0008 — purchase tokens cifrados em repouso
--
-- Antes desta migration o comprovante do Google ficava em texto claro em
-- `subscriptions.purchase_token`, `linked_purchase_token`, `subscription_events`
-- e dentro de `raw`/`payload`. Qualquer SELECT (backup, dump, papel de tenant)
-- expunha um segredo suficiente para consultar a Play Developer API.
--
-- Passamos a guardar:
--   * hash SHA-256 para UNIQUE e busca;
--   * blob AES-GCM (aplicação) ou envelope `v0:` legado só na transição.
--
-- Linhas já existentes recebem `v0:<plaintext>` para a API recriptografar na
-- próxima escrita. Bancos novos (ou resetados) não passam por esse legado.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN purchase_token_hash text,
  ADD COLUMN purchase_token_enc text,
  ADD COLUMN linked_purchase_token_hash text,
  ADD COLUMN linked_purchase_token_enc text;

UPDATE subscriptions
SET
  purchase_token_hash = encode(digest(convert_to(purchase_token, 'UTF8'), 'sha256'), 'hex'),
  purchase_token_enc = 'v0:' || purchase_token,
  linked_purchase_token_hash = CASE
    WHEN linked_purchase_token IS NULL THEN NULL
    ELSE encode(digest(convert_to(linked_purchase_token, 'UTF8'), 'sha256'), 'hex')
  END,
  linked_purchase_token_enc = CASE
    WHEN linked_purchase_token IS NULL THEN NULL
    ELSE 'v0:' || linked_purchase_token
  END;

ALTER TABLE subscriptions
  ALTER COLUMN purchase_token_hash SET NOT NULL,
  ALTER COLUMN purchase_token_enc SET NOT NULL;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_purchase_token_key;
DROP INDEX IF EXISTS subscriptions_linked_token_idx;

ALTER TABLE subscriptions
  DROP COLUMN purchase_token,
  DROP COLUMN linked_purchase_token;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_purchase_token_hash_key UNIQUE (purchase_token_hash);

CREATE INDEX subscriptions_linked_token_hash_idx
  ON subscriptions (linked_purchase_token_hash)
  WHERE linked_purchase_token_hash IS NOT NULL;

-- JSON do Google não precisa do token espelhado.
UPDATE subscriptions
SET raw = raw - ARRAY['linkedPurchaseToken', 'purchaseToken']::text[]
WHERE raw ? 'linkedPurchaseToken' OR raw ? 'purchaseToken';

-- ---------------------------------------------------------------------------
-- subscription_events
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_events
  ADD COLUMN purchase_token_hash text,
  ADD COLUMN purchase_token_enc text;

UPDATE subscription_events
SET
  purchase_token_hash = CASE
    WHEN purchase_token IS NULL THEN NULL
    ELSE encode(digest(convert_to(purchase_token, 'UTF8'), 'sha256'), 'hex')
  END,
  purchase_token_enc = CASE
    WHEN purchase_token IS NULL THEN NULL
    ELSE 'v0:' || purchase_token
  END;

DROP INDEX IF EXISTS subscription_events_token_idx;

ALTER TABLE subscription_events DROP COLUMN purchase_token;

CREATE INDEX subscription_events_token_hash_idx
  ON subscription_events (purchase_token_hash, received_at DESC);

UPDATE subscription_events
SET payload = ((payload #- '{subscriptionNotification,purchaseToken}')
               #- '{oneTimeProductNotification,purchaseToken}')
              - ARRAY['purchaseToken']::text[]
WHERE payload::text LIKE '%purchaseToken%';

-- ---------------------------------------------------------------------------
-- Tenant: não ler hash/ciphertext/raw
-- ---------------------------------------------------------------------------

REVOKE ALL ON subscriptions FROM app_user;
GRANT SELECT (
  id,
  workspace_id,
  purchaser_user_id,
  plan_key,
  google_product_id,
  google_base_plan_id,
  google_offer_id,
  state,
  auto_renewing,
  acknowledged,
  started_at,
  current_period_end,
  grace_until,
  canceled_at,
  cancel_reason,
  superseded_by,
  latest_notification_type,
  last_verified_at,
  created_at,
  updated_at
) ON subscriptions TO app_user;

REVOKE ALL ON subscription_events FROM app_user;
