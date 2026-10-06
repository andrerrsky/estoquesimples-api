-- Imagens dos produtos.
--
-- O binário vive num bucket S3 (Railway), nunca no banco. Aqui ficam só os
-- metadados e a posse: cada imagem é identificada pelo SHA-256 do conteúdo
-- guardado (`hash`), dentro de UMA empresa. O produto aponta para ela por
-- `products.photo_hash` (coluna que já existia desde a 0004 e nunca foi
-- usada), e esse ponteiro sincroniza como qualquer outro campo do produto.
--
-- Identificar por conteúdo dá três coisas sem código extra: o mesmo arquivo
-- enviado duas vezes (reenvio depois de falha, dois aparelhos) vira uma linha
-- só; a URL muda quando a imagem muda, então o cache nunca mostra versão
-- velha; e o conteúdo de um hash nunca muda, então pode ser cacheado para
-- sempre.

CREATE TABLE workspace_images (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- SHA-256 (hex) dos bytes guardados no bucket.
  hash          text        NOT NULL,
  -- SHA-256 (hex) dos bytes como chegaram. Quando a API reencoda a imagem
  -- (formato, tamanho ou metadados fora do padrão) o hash guardado difere do
  -- enviado; este campo faz o reenvio do mesmo arquivo ser reconhecido sem
  -- processar de novo. Não é único: arquivos diferentes podem resultar no
  -- mesmo conteúdo guardado.
  source_hash   text        NOT NULL,
  content_type  text        NOT NULL,
  bytes         integer     NOT NULL,
  width         integer     NOT NULL,
  height        integer     NOT NULL,
  created_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Coleta de lixo: marcada quando nenhum produto referencia a imagem, apagada
  -- depois de um período de carência. Volta a NULL se alguém voltar a usá-la.
  orphaned_at   timestamptz,
  CONSTRAINT workspace_images_hash_check CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_images_source_hash_check CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_images_bytes_check CHECK (bytes > 0),
  CONSTRAINT workspace_images_dims_check CHECK (width > 0 AND height > 0),
  CONSTRAINT workspace_images_hash_unique UNIQUE (workspace_id, hash)
);

-- Reconhecer o reenvio do mesmo arquivo sem processá-lo de novo.
CREATE INDEX workspace_images_source_idx ON workspace_images (workspace_id, source_hash);

CREATE INDEX workspace_images_orphan_idx ON workspace_images (orphaned_at) WHERE orphaned_at IS NOT NULL;

-- products.photo_hash só aceita o formato do hash; a existência da imagem na
-- empresa é conferida pela API (uma FK composta exigiria a linha antes do
-- produto e quebraria a ordem de chegada das operações de sincronização).
ALTER TABLE products
  ADD CONSTRAINT products_photo_hash_check CHECK (photo_hash IS NULL OR photo_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE workspace_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_images FORCE  ROW LEVEL SECURITY;

CREATE POLICY workspace_images_tenant ON workspace_images
  USING      (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

CREATE POLICY workspace_images_system ON workspace_images
  USING      (app_is_system_context())
  WITH CHECK (app_is_system_context());

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_images TO app_user;

-- Cota de armazenamento por plano, em MB (NULL = sem limite). Editável no
-- painel, como os demais recursos.
INSERT INTO plan_features (plan_key, feature_key, enabled, limit_value) VALUES
  ('gratuito', 'imagens.armazenamento_mb', true, 100),
  ('basico',   'imagens.armazenamento_mb', true, 5000)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
