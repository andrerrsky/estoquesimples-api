DROP INDEX IF EXISTS support_tickets_needs_human_idx;
ALTER TABLE support_tickets DROP COLUMN IF EXISTS needs_human_reason;
ALTER TABLE support_tickets DROP COLUMN IF EXISTS needs_human_at;
ALTER TABLE support_tickets DROP COLUMN IF EXISTS needs_human;
ALTER TABLE support_messages DROP COLUMN IF EXISTS ai;
