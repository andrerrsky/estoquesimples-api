-- 0010 — avaliações da Play Store e configurações do painel.
--
-- `play_reviews` é a cópia local do que a Play Developer API devolve. A API
-- do Google só lista avaliações com comentário alteradas nos últimos sete
-- dias; sem guardar, o histórico some. `admin_settings` guarda chaves de
-- serviços de terceiros que o painel usa (hoje, a da OpenAI para rascunhos
-- de resposta), cifradas com a mesma chave AES do restante dos segredos em
-- repouso — nunca em texto claro.

CREATE TABLE play_reviews (
  review_id            text        PRIMARY KEY,
  author_name          text,
  star_rating          integer     NOT NULL,
  text                 text,
  language             text,
  device               text,
  android_os_version   text,
  app_version_code     integer,
  app_version_name     text,
  -- Momento do comentário do usuário e da última alteração (edição ou resposta).
  user_comment_at      timestamptz,
  last_modified_at     timestamptz,
  developer_reply_text text,
  developer_reply_at   timestamptz,
  -- Verdadeiro quando a resposta saiu por este painel (e não pelo Play Console).
  replied_via_panel    boolean     NOT NULL DEFAULT false,
  replied_by_admin_id  uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  raw                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  fetched_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_reviews_rating_check CHECK (star_rating BETWEEN 1 AND 5)
);

CREATE INDEX play_reviews_time_idx ON play_reviews (last_modified_at DESC);
CREATE INDEX play_reviews_unanswered_idx ON play_reviews (last_modified_at DESC)
  WHERE developer_reply_text IS NULL;

CREATE TABLE admin_settings (
  key        text        PRIMARY KEY,
  value_enc  text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES platform_admins (id) ON DELETE SET NULL
);

ALTER TABLE play_reviews   ENABLE ROW LEVEL SECURITY;
ALTER TABLE play_reviews   FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY play_reviews_system ON play_reviews
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
CREATE POLICY admin_settings_system ON admin_settings
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());
