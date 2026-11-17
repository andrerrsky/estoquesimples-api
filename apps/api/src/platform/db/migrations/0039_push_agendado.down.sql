UPDATE push_campaigns SET status = 'cancelled' WHERE status = 'scheduled';
ALTER TABLE push_campaigns DROP CONSTRAINT IF EXISTS push_campaigns_status_check;
ALTER TABLE push_campaigns ADD CONSTRAINT push_campaigns_status_check
  CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'cancelled'));
DROP INDEX IF EXISTS push_campaigns_scheduled_idx;
ALTER TABLE push_campaigns DROP COLUMN IF EXISTS scheduled_at;
