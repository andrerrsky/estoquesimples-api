DROP INDEX IF EXISTS subscriptions_coupon_idx;
ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS promo_restored_at,
  DROP COLUMN IF EXISTS coupon_id;
DROP TABLE IF EXISTS coupon_redemptions;
DROP TABLE IF EXISTS coupons;
