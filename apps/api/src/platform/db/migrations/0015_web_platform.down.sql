ALTER TABLE push_campaigns DROP COLUMN IF EXISTS inbox_count;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS billing_payments;
DROP TABLE IF EXISTS billing_customers;

DROP INDEX IF EXISTS subscription_events_provider_sub_idx;
ALTER TABLE subscription_events
  DROP CONSTRAINT IF EXISTS subscription_events_provider_check,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS event_type,
  DROP COLUMN IF EXISTS provider_subscription_id,
  DROP COLUMN IF EXISTS attempts;

ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_web_price_monthly_check,
  DROP CONSTRAINT IF EXISTS plans_web_price_yearly_check,
  DROP COLUMN IF EXISTS web_price_monthly_cents,
  DROP COLUMN IF EXISTS web_price_yearly_cents;

DROP INDEX IF EXISTS subscriptions_provider_id_unique;
DELETE FROM subscriptions WHERE provider <> 'google_play';
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_provider_fields_check,
  DROP CONSTRAINT IF EXISTS subscriptions_provider_check,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS provider_subscription_id,
  DROP COLUMN IF EXISTS provider_customer_id,
  DROP COLUMN IF EXISTS billing_cycle,
  DROP COLUMN IF EXISTS billing_type,
  DROP COLUMN IF EXISTS price_cents,
  DROP COLUMN IF EXISTS next_due_date;
ALTER TABLE subscriptions
  ALTER COLUMN purchase_token_hash SET NOT NULL,
  ALTER COLUMN purchase_token_enc  SET NOT NULL,
  ALTER COLUMN google_product_id   SET NOT NULL;
