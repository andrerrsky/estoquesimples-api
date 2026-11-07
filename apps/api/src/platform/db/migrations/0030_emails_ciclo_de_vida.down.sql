DROP TABLE IF EXISTS email_send_counts;
DROP TABLE IF EXISTS lifecycle_emails;
ALTER TABLE users DROP COLUMN IF EXISTS email_suppressed_at;
ALTER TABLE users DROP COLUMN IF EXISTS lifecycle_emails_opt_out_at;
