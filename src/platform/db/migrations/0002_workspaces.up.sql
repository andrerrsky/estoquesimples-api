-- Fase 2: workspaces, membros, papéis e permissões.

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

CREATE TABLE workspaces (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  owner_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  -- Contador monotônico por tenant, base do cursor de sincronização.
  --
  -- Deliberadamente NÃO usamos um BIGSERIAL global: com uma sequence, duas
  -- transações concorrentes podem obter os números 10 e 11 e commitar na
  -- ordem inversa. Um cliente que lesse "tudo acima de 10" nesse intervalo
  -- perderia o registro 10 para sempre, sem erro nenhum. Incrementar uma
  -- coluna da linha do workspace serializa as escritas daquele tenant e
  -- garante um cursor sem buracos, que é o que torna o pull confiável.
  change_seq    bigint      NOT NULL DEFAULT 0,

  settings      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT workspaces_name_check CHECK (length(btrim(name)) > 0)
);

CREATE INDEX workspaces_owner_idx ON workspaces (owner_user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A FK ficou pendente na migration 0001 porque workspaces ainda não existia.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE SET NULL;

/*
 * Aloca o próximo número de ordenação do workspace.
 *
 * O UPDATE trava a linha do workspace até o fim da transação, então dois
 * writers concorrentes recebem números distintos e em ordem de commit.
 */
CREATE OR REPLACE FUNCTION next_change_seq(target_workspace uuid) RETURNS bigint
  LANGUAGE plpgsql
  AS $$
DECLARE
  next_value bigint;
BEGIN
  UPDATE workspaces
  SET change_seq = change_seq + 1
  WHERE id = target_workspace
  RETURNING change_seq INTO next_value;

  IF next_value IS NULL THEN
    RAISE EXCEPTION 'workspace % não encontrado', target_workspace;
  END IF;

  RETURN next_value;
END
$$;

-- ---------------------------------------------------------------------------
-- Papéis e permissões
--
-- Modelados como dados, não como constantes no código. Adicionar um papel ou
-- ajustar o que um papel pode fazer vira uma migration, sem caçar comparações
-- de string espalhadas por controllers.
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  key         text        PRIMARY KEY,
  name        text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  -- Ordena a hierarquia: ninguém pode promover alguém a um papel de rank
  -- maior ou igual ao seu próprio.
  rank        integer     NOT NULL,
  is_system   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key         text        PRIMARY KEY,
  category    text        NOT NULL,
  description text        NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
  role_key       text NOT NULL REFERENCES roles (key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

INSERT INTO roles (key, name, description, rank) VALUES
  ('proprietario',  'Proprietário',  'Controle total, incluindo assinatura e exclusão da empresa.', 100),
  ('administrador', 'Administrador', 'Gerencia dados e membros, sem poder excluir ou transferir a empresa.', 80),
  ('gerente',       'Gerente',       'Gerencia produtos e movimentações; vê membros e auditoria.', 60),
  ('operador',      'Operador',      'Registra entradas e saídas e mantém o cadastro de produtos.', 40),
  ('consulta',      'Somente consulta', 'Apenas visualiza dados.', 20);

INSERT INTO permissions (key, category, description) VALUES
  ('produtos.ver',            'produtos',      'Visualizar produtos'),
  ('produtos.criar',          'produtos',      'Cadastrar produtos'),
  ('produtos.editar',         'produtos',      'Editar produtos'),
  ('produtos.excluir',        'produtos',      'Excluir produtos'),
  ('movimentacoes.ver',       'movimentacoes', 'Visualizar movimentações'),
  ('movimentacoes.entrada',   'movimentacoes', 'Registrar entrada'),
  ('movimentacoes.saida',     'movimentacoes', 'Registrar saída'),
  ('movimentacoes.ajuste',    'movimentacoes', 'Registrar ajuste de estoque'),
  ('movimentacoes.cancelar',  'movimentacoes', 'Cancelar movimentação por evento compensatório'),
  ('membros.ver',             'membros',       'Visualizar membros'),
  ('membros.convidar',        'membros',       'Convidar usuários'),
  ('membros.remover',         'membros',       'Remover usuários'),
  ('membros.suspender',       'membros',       'Suspender ou reativar usuários'),
  ('membros.alterar_papel',   'membros',       'Alterar permissões de usuários'),
  ('assinatura.ver',          'assinatura',    'Consultar situação da assinatura'),
  ('assinatura.gerenciar',    'assinatura',    'Vincular e gerenciar a assinatura'),
  ('auditoria.ver',           'auditoria',     'Visualizar a auditoria'),
  ('workspace.ver',           'workspace',     'Visualizar dados da empresa'),
  ('workspace.configurar',    'workspace',     'Alterar configurações da empresa'),
  ('workspace.transferir',    'workspace',     'Transferir a propriedade da empresa'),
  ('workspace.excluir',       'workspace',     'Excluir a empresa'),
  ('sync.executar',           'sincronizacao', 'Sincronizar dados'),
  ('conflitos.ver',           'sincronizacao', 'Visualizar conflitos'),
  ('conflitos.resolver',      'sincronizacao', 'Resolver conflitos');

-- Proprietário: tudo.
INSERT INTO role_permissions (role_key, permission_key)
SELECT 'proprietario', key FROM permissions;

-- Administrador: tudo, menos o que é privativo do dono da empresa.
INSERT INTO role_permissions (role_key, permission_key)
SELECT 'administrador', key FROM permissions
WHERE key NOT IN ('workspace.transferir', 'workspace.excluir', 'assinatura.gerenciar');

INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('gerente', 'produtos.ver'),
  ('gerente', 'produtos.criar'),
  ('gerente', 'produtos.editar'),
  ('gerente', 'produtos.excluir'),
  ('gerente', 'movimentacoes.ver'),
  ('gerente', 'movimentacoes.entrada'),
  ('gerente', 'movimentacoes.saida'),
  ('gerente', 'movimentacoes.ajuste'),
  ('gerente', 'movimentacoes.cancelar'),
  ('gerente', 'membros.ver'),
  ('gerente', 'auditoria.ver'),
  ('gerente', 'workspace.ver'),
  ('gerente', 'assinatura.ver'),
  ('gerente', 'sync.executar'),
  ('gerente', 'conflitos.ver'),
  ('gerente', 'conflitos.resolver'),

  ('operador', 'produtos.ver'),
  ('operador', 'produtos.criar'),
  ('operador', 'produtos.editar'),
  ('operador', 'movimentacoes.ver'),
  ('operador', 'movimentacoes.entrada'),
  ('operador', 'movimentacoes.saida'),
  ('operador', 'workspace.ver'),
  ('operador', 'sync.executar'),
  ('operador', 'conflitos.ver'),

  ('consulta', 'produtos.ver'),
  ('consulta', 'movimentacoes.ver'),
  ('consulta', 'workspace.ver'),
  ('consulta', 'sync.executar');

GRANT SELECT ON roles, permissions, role_permissions TO app_user;

-- ---------------------------------------------------------------------------
-- Membros
-- ---------------------------------------------------------------------------

CREATE TABLE workspace_members (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_key     text        NOT NULL REFERENCES roles (key) ON DELETE RESTRICT,
  status       text        NOT NULL DEFAULT 'active',
  invited_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  CONSTRAINT workspace_members_status_check CHECK (status IN ('active', 'suspended', 'removed'))
);

-- Um usuário aparece uma única vez por empresa, mesmo depois de removido:
-- readmitir reativa a linha existente em vez de criar outra.
CREATE UNIQUE INDEX workspace_members_unique ON workspace_members (workspace_id, user_id);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id) WHERE status = 'active';
CREATE INDEX workspace_members_workspace_idx ON workspace_members (workspace_id, status);

CREATE TRIGGER workspace_members_set_updated_at
  BEFORE UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Convites
-- ---------------------------------------------------------------------------

CREATE TABLE invites (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email        text        NOT NULL,
  role_key     text        NOT NULL REFERENCES roles (key) ON DELETE RESTRICT,
  -- Só o hash. O token em claro existe uma única vez, no e-mail enviado.
  token_hash   text        NOT NULL UNIQUE,
  invited_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- No máximo um convite pendente por e-mail em cada empresa. Reenviar
-- substitui o anterior em vez de acumular links válidos.
CREATE UNIQUE INDEX invites_pending_unique
  ON invites (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX invites_workspace_idx ON invites (workspace_id, created_at DESC);

CREATE TRIGGER invites_set_updated_at
  BEFORE UPDATE ON invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- Última linha de defesa. A camada de aplicação já filtra por workspace em
-- todo repositório; estas políticas garantem que um filtro esquecido vire
-- "nenhuma linha" em vez de "dados de outra empresa".
--
-- Não aplicamos RLS por workspace em `workspaces`: listar "minhas empresas"
-- é uma operação que legitimamente atravessa tenants, e essa consulta é
-- sempre restringida pelo user_id vindo do token.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, workspace_members, invites TO app_user;
GRANT SELECT, INSERT ON audit_log TO app_user;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_user;

-- Remover ou suspender um membro precisa derrubar as sessões dele na mesma
-- transação da remoção: se as duas coisas não forem atômicas, existe uma
-- janela em que o usuário já saiu da empresa mas ainda sincroniza. Por isso o
-- papel de tenant recebe acesso a `users` e `sessions` — restrito, pelas
-- políticas abaixo, a quem participa da empresa corrente.
GRANT SELECT, UPDATE ON users TO app_user;
GRANT SELECT, UPDATE ON sessions TO app_user;

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- Duas situações legítimas: operar dentro da empresa corrente, ou consultar
-- as próprias participações para montar a lista de empresas do usuário.
CREATE POLICY workspace_members_access ON workspace_members
  USING (
    workspace_id = app_current_workspace()
    OR user_id = app_current_user()
  )
  WITH CHECK (workspace_id = app_current_workspace());

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY invites_tenant ON invites
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

/*
 * `users` e `sessions` são globais, não pertencem a um tenant. Como o papel
 * de tenant precisa alterá-los para desligar um membro, as políticas limitam
 * o alcance às pessoas que participam da empresa corrente (mais o próprio
 * usuário autenticado). Assim, mesmo uma consulta sem filtro dentro de uma
 * transação de tenant não alcança contas de outras empresas.
 *
 * As rotas de autenticação (login, refresh, redefinição de senha) rodam fora
 * do contexto de tenant, com o papel dono das tabelas, que não é submetido a
 * RLS — por isso continuam enxergando o que precisam.
 */
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_tenant_scope ON users
  USING (
    id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = users.id
    )
  );

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_tenant_scope ON sessions
  USING (
    user_id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = sessions.user_id
    )
  );
