-- Identidade visual por empresa (white-label leve).
--
-- É só uma camada de tema sobre a interface única do produto: cores, fonte e
-- logotipo. A configuração fica guardada mesmo quando a empresa perde o
-- direito ao recurso; quem decide se ela é APLICADA é o plano em vigor
-- (recurso `marca.personalizada`), consultado a cada leitura, nunca uma
-- coluna daqui. Assim, cancelar a assinatura volta ao visual padrão sem
-- apagar nada, e reassinar restaura.
--
-- O logotipo é um objeto no bucket (`workspaces/<id>/brand/<hash>.webp`),
-- fora da cota de fotos dos produtos; aqui só os metadados.

CREATE TABLE workspace_brandings (
  workspace_id       uuid        PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Identificador público da URL /<slug>/entrar. Único, minúsculo, normalizado
  -- pela API (ver modules/branding/brand-rules.ts).
  slug               text,
  -- Cores #rrggbb; NULL = padrão do Estoque Simples.
  primary_color      text,
  accent_color       text,
  text_color         text,
  font               text        NOT NULL DEFAULT 'default',
  logo_hash          text,
  logo_content_type  text,
  logo_bytes         integer,
  logo_width         integer,
  logo_height        integer,
  -- Moderação pelo painel: bloqueada, a marca não é aplicada nem exposta.
  blocked_at         timestamptz,
  blocked_reason     text,
  -- Sobe a cada alteração; os clientes usam para invalidar cache.
  version            integer     NOT NULL DEFAULT 1,
  updated_by         uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_brandings_slug_check  CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT workspace_brandings_slug_len    CHECK (slug IS NULL OR char_length(slug) BETWEEN 3 AND 32),
  CONSTRAINT workspace_brandings_primary_check CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT workspace_brandings_accent_check  CHECK (accent_color  IS NULL OR accent_color  ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT workspace_brandings_text_check    CHECK (text_color    IS NULL OR text_color    ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT workspace_brandings_font_check    CHECK (font IN ('default', 'serif')),
  CONSTRAINT workspace_brandings_logo_check    CHECK (logo_hash IS NULL OR logo_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX workspace_brandings_slug_unique ON workspace_brandings (slug) WHERE slug IS NOT NULL;

-- Identificadores abandonados ficam reservados para a empresa que os tinha:
-- sem isso, quem trocasse de identificador abriria a porta para outra empresa
-- ocupar o endereço antigo (e se passar por ela numa tela de login).
CREATE TABLE brand_slug_reservations (
  slug         text        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  released_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_slug_reservations_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
CREATE INDEX brand_slug_reservations_workspace_idx ON brand_slug_reservations (workspace_id);

ALTER TABLE workspace_brandings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_brandings FORCE  ROW LEVEL SECURITY;
CREATE POLICY workspace_brandings_tenant ON workspace_brandings
  USING      (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());
CREATE POLICY workspace_brandings_system ON workspace_brandings
  USING      (app_is_system_context())
  WITH CHECK (app_is_system_context());

ALTER TABLE brand_slug_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_slug_reservations FORCE  ROW LEVEL SECURITY;
CREATE POLICY brand_slug_reservations_tenant ON brand_slug_reservations
  USING      (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());
CREATE POLICY brand_slug_reservations_system ON brand_slug_reservations
  USING      (app_is_system_context())
  WITH CHECK (app_is_system_context());

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_brandings, brand_slug_reservations TO app_user;

-- Quem configura a marca: proprietário e administrador.
INSERT INTO permissions (key, category, description) VALUES
  ('marca.gerenciar', 'workspace', 'Personalizar a identidade visual da empresa');
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('proprietario',  'marca.gerenciar'),
  ('administrador', 'marca.gerenciar');

-- Recurso do plano (editável no painel). Só o plano pago inclui.
INSERT INTO plan_features (plan_key, feature_key, enabled, limit_value) VALUES
  ('gratuito', 'marca.personalizada', false, NULL),
  ('basico',   'marca.personalizada', true,  NULL)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
