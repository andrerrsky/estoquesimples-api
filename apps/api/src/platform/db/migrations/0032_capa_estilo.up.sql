-- Estilo sorteado para a capa gerada pela IA (tipo de comércio, pessoa e
-- enquadramento). A próxima capa evita repetir o que as últimas usaram.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS cover_style jsonb;
