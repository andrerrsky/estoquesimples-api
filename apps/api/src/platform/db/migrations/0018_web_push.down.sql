ALTER TABLE push_tokens DROP CONSTRAINT IF EXISTS push_tokens_web_keys_check;
ALTER TABLE push_tokens DROP COLUMN IF EXISTS web_push_keys;
