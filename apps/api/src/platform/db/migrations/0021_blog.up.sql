-- Blog: dicas, avisos e novidades para quem usa o Estoque Simples, editado
-- pelo painel e, duas vezes por semana, escrito pela OpenAI (marcado como
-- tal). O conteúdo fica em Markdown (fonte) e em HTML já renderizado e
-- limpo (o que a web, o app e os buscadores leem).
CREATE TABLE blog_posts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text        NOT NULL UNIQUE,
  title            text        NOT NULL,
  seo_title        text,
  excerpt          text        NOT NULL,
  content_md       text        NOT NULL,
  content_html     text        NOT NULL,
  category         text        NOT NULL,
  tags             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  faq              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status           text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at     timestamptz,
  cover_hash       text,
  cover_alt        text,
  author_name      text        NOT NULL DEFAULT 'Equipe Estoque Simples',
  reading_minutes  integer     NOT NULL DEFAULT 3,
  ai_generated     boolean     NOT NULL DEFAULT false,
  ai_model         text,
  ai_topic         text,
  notified_at      timestamptz,
  created_by       uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX blog_posts_published_idx ON blog_posts (published_at DESC) WHERE status = 'published';
CREATE INDEX blog_posts_category_idx ON blog_posts (category, published_at DESC);
CREATE INDEX blog_posts_ai_topic_idx ON blog_posts (ai_topic) WHERE ai_topic IS NOT NULL;
