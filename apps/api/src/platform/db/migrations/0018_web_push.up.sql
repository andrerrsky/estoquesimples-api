-- Web Push (web app no iPhone/iPad, Android e computador): a inscrição do
-- navegador é guardada na mesma tabela dos tokens do FCM. `token` passa a ser
-- o endpoint do serviço de push do navegador e estas são as chaves com que a
-- mensagem é cifrada para ele (p256dh e auth, RFC 8291). Nulas nos tokens FCM.
ALTER TABLE push_tokens ADD COLUMN web_push_keys jsonb;

ALTER TABLE push_tokens
  ADD CONSTRAINT push_tokens_web_keys_check
  CHECK (platform <> 'web' OR web_push_keys IS NOT NULL) NOT VALID;
