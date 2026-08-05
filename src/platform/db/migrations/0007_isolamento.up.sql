-- Fase 9: fechamento do isolamento multi-tenant.
--
-- As migrations anteriores montaram o isolamento em duas camadas: o filtro por
-- workspace na aplicação e as políticas de RLS no banco. A segunda camada
-- ficou com buracos que só aparecem quando a primeira falha — que é
-- exatamente o cenário para o qual ela existe. Esta migration fecha os quatro
-- principais:
--
--   1. `workspaces` e `audit_log` tinham GRANT para o papel de tenant e
--      nenhuma política. Dentro de uma transação de tenant, a única coisa que
--      limitava um UPDATE ou um SELECT nessas tabelas era o WHERE da consulta.
--   2. Nenhuma tabela tinha FORCE ROW LEVEL SECURITY, então todo o isolamento
--      dependia de o `SET LOCAL ROLE app_user` ter sido executado.
--   3. As chaves estrangeiras não eram escopadas por workspace, e a checagem
--      de integridade referencial ignora RLS por definição — então um tenant
--      conseguia apontar para linhas de outra empresa.
--   4. `users` e `sessions` recebiam GRANT em todas as colunas, o que no nível
--      do banco permitia a um membro reescrever o password_hash de um colega.
--
-- ---------------------------------------------------------------------------
-- A decisão central desta migration: o que é "contexto de sistema"
--
-- FORCE ROW LEVEL SECURITY submete o próprio dono das tabelas às políticas. É
-- o que fecha o buraco 2 — mas também filtraria todo caminho legítimo que roda
-- como dono: a limpeza de lápides (sync.jobs), a reconciliação de assinaturas
-- (billing.service), as rotas de autenticação, a auditoria de eventos de conta
-- e as próprias migrations. Aplicar FORCE sem uma saída para esses caminhos
-- não deixaria o banco mais seguro; deixaria os jobs quebrados em silêncio,
-- devolvendo "0 linhas afetadas" em vez de erro.
--
-- A saída convencional é um GUC ligado dentro de `withSystem`. Não serve aqui:
-- as sessões de tenant e as de sistema compartilham o mesmo pool de conexões e
-- o mesmo papel de login, então uma variável de sessão ligada no login vazaria
-- para as transações de tenant e desligaria o isolamento inteiro.
--
-- O critério adotado usa as duas marcas que `withTenant` deixa e que nenhum
-- caminho de sistema deixa:
--
--   contexto de sistema  <=>  papel efetivo != app_user  E  app.workspace_id vazio
--
-- Consequências, todas desejadas:
--   * job/reconciliação/migration (dono, sem workspace)  -> enxerga tudo;
--   * requisição de tenant (app_user, com workspace)     -> enxerga a empresa;
--   * requisição servida pelo dono por engano, mas com o workspace definido
--     -> continua filtrada pela empresa, que é o ganho real do FORCE;
--   * sessão app_user sem workspace definido             -> não enxerga nada.
--
-- `app.workspace_id` é sempre definido com `set_config(..., true)`, ou seja,
-- vive só até o fim da transação: uma transação de sistema que reutilize a
-- conexão de uma requisição de tenant não herda o valor.
-- ---------------------------------------------------------------------------

-- Chaves estrangeiras compostas com ON DELETE SET NULL restrito a algumas
-- colunas (usadas mais abaixo) só existem a partir do PostgreSQL 15. Falhar
-- aqui, com mensagem clara, é melhor do que falhar no meio do DDL.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'Esta migration exige PostgreSQL 15 ou superior (ON DELETE SET NULL com lista de colunas).';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Contexto de sistema
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_is_system_context() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT current_user <> 'app_user'::name
       AND app_current_workspace() IS NULL
  $$;

COMMENT ON FUNCTION app_is_system_context() IS
  'Verdadeiro nos caminhos que legitimamente cruzam tenants (jobs, reconciliação, '
  'autenticação, migrations): papel diferente de app_user e nenhum workspace na transação.';

-- ---------------------------------------------------------------------------
-- C-02 — `workspaces` passa a ter RLS
--
-- O comentário da migration 0002 dispensava RLS aqui porque "listar minhas
-- empresas" atravessa tenants. A premissa estava errada: essa listagem roda
-- como dono, fora de `withTenant` (workspaces.service.listForUser), então
-- nunca esteve sujeita a política nenhuma. O que o GRANT aberto permitia, na
-- prática, era um UPDATE sem WHERE dentro de uma transação de tenant renomear
-- todas as empresas do banco, e um DELETE cascatear em produtos,
-- movimentações, assinaturas, membros e convites.
--
-- A política admite a empresa corrente e as empresas das quais o usuário
-- autenticado participa (a segunda condição preserva qualquer leitura de
-- "minhas empresas" que venha a rodar dentro do contexto de tenant), mas o
-- WITH CHECK só aceita escrita na empresa corrente.
-- ---------------------------------------------------------------------------

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;

CREATE POLICY workspaces_tenant ON workspaces
  USING (
    id = app_current_workspace()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = workspaces.id
        AND wm.user_id = app_current_user()
        AND wm.status <> 'removed'
    )
  )
  WITH CHECK (id = app_current_workspace());

CREATE POLICY workspaces_system ON workspaces
  USING (app_is_system_context())
  WITH CHECK (app_is_system_context());

-- Criar e excluir empresa rodam como dono (workspaces.service.create abre uma
-- transação de sistema; não existe caminho de exclusão). O tenant só precisa
-- ler e escrever nas quatro colunas abaixo:
--   name, settings     -> PATCH /workspaces/:id
--   owner_user_id      -> transferência de propriedade
--   seeded_at          -> conclusão da carga inicial
-- `change_seq` fica de fora de propósito: quem o incrementa é a função
-- next_change_seq, logo abaixo, e deixá-lo aberto permitiria a uma empresa
-- estragar o próprio cursor de sincronização com um UPDATE direto.
-- `tombstone_horizon_seq` só é escrito pela limpeza de lápides, que roda como
-- dono.
REVOKE ALL ON workspaces FROM app_user;
GRANT SELECT ON workspaces TO app_user;
GRANT UPDATE (name, settings, owner_user_id, seeded_at) ON workspaces TO app_user;

-- ---------------------------------------------------------------------------
-- C-02 — `next_change_seq` deixa de ser pública
--
-- O Postgres concede EXECUTE a PUBLIC em toda função nova, e a versão original
-- não checava nada: qualquer sessão de tenant podia incrementar o change_seq
-- de outra empresa. O efeito não é sutil — o cursor de todos os aparelhos da
-- vítima passa a ficar atrás do contador da empresa, o guard de sync.service
-- responde SYNC_RESYNC_REQUIRED e a empresa inteira recarrega tudo.
--
-- A função vira SECURITY DEFINER por dois motivos: para poder incrementar
-- change_seq sem que o papel de tenant tenha UPDATE nessa coluna, e para que a
-- checagem do workspace alvo aconteça num lugar só. Com search_path fixo,
-- porque SECURITY DEFINER sem search_path é um vetor de escalonamento.
--
-- O caminho de sistema continua funcionando: quando não há workspace na
-- transação (jobs, reconciliação), a checagem é dispensada. Rodando como dono,
-- a função ainda está sujeita ao FORCE de `workspaces`, e o UPDATE passa
-- porque o alvo é justamente a empresa corrente.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_change_seq(target_workspace uuid) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  corrente   uuid;
  next_value bigint;
BEGIN
  corrente := app_current_workspace();

  IF corrente IS NOT NULL AND corrente <> target_workspace THEN
    RAISE EXCEPTION 'sequência da empresa % não pode ser alterada fora do contexto dela',
      target_workspace
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

REVOKE ALL ON FUNCTION next_change_seq(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_change_seq(uuid) TO app_user;

-- ---------------------------------------------------------------------------
-- C-03 — `audit_log` passa a ter RLS
--
-- A tabela tinha GRANT SELECT, INSERT para o papel de tenant e nenhuma
-- política: qualquer membro de qualquer empresa lia a trilha completa de todas
-- as outras (ações, ids de entidade, quem fez, endereço IP, metadados) e podia
-- gravar entradas com o workspace_id que quisesse.
--
-- Ficou a política simples, e não uma função SECURITY DEFINER que carimbasse o
-- workspace: os eventos de conta (login, troca de senha, reuso de token) são
-- gravados com workspace_id NULL e fora de contexto de tenant, e trocar o
-- caminho de escrita exigiria alterar audit.service.ts. Esses eventos entram
-- pelo contexto de sistema; dentro de uma transação de tenant, o workspace da
-- linha precisa ser o corrente.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_tenant ON audit_log
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

CREATE POLICY audit_log_system ON audit_log
  USING (app_is_system_context())
  WITH CHECK (app_is_system_context());

-- M-05 — o que fazer com audit_log.workspace_id quando a empresa some.
--
-- Mantido o ON DELETE SET NULL de propósito. CASCADE apagaria a trilha de
-- auditoria justamente do evento mais sensível (a exclusão da empresa), e
-- RESTRICT impediria a exclusão por causa do próprio registro que a documenta.
-- O efeito colateral apontado — linhas órfãs invisíveis para toda política de
-- tenant — é aceitável porque `audit_log_system` garante o caminho de leitura
-- pelo dono, que é quem opera a retenção e responde a incidentes.
COMMENT ON CONSTRAINT audit_log_workspace_fk ON audit_log IS
  'SET NULL deliberado: a trilha sobrevive à exclusão da empresa. As linhas órfãs, '
  'como os eventos de conta, só são legíveis no contexto de sistema (audit_log_system).';

-- ---------------------------------------------------------------------------
-- A-11 — FORCE ROW LEVEL SECURITY em todas as tabelas de tenant
--
-- Sem FORCE, o dono das tabelas ignora as políticas, e a aplicação conecta
-- justamente como dono: o isolamento inteiro depende de uma única instrução
-- (`SET LOCAL ROLE app_user`) ter sido executada. Com FORCE mais a política de
-- sistema, o critério deixa de ser "quem sou" e passa a ser "que contexto foi
-- declarado" — uma consulta que passe pelo handle cru do banco com o workspace
-- definido continua restrita àquela empresa.
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_members      FORCE ROW LEVEL SECURITY;
ALTER TABLE invites                FORCE ROW LEVEL SECURITY;
ALTER TABLE users                  FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions               FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions          FORCE ROW LEVEL SECURITY;
ALTER TABLE products               FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements        FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_operations        FORCE ROW LEVEL SECURITY;
ALTER TABLE initial_uploads        FORCE ROW LEVEL SECURITY;
ALTER TABLE initial_upload_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors           FORCE ROW LEVEL SECURITY;
ALTER TABLE conflict_log           FORCE ROW LEVEL SECURITY;

-- Políticas permissivas são combinadas com OR, então acrescentar a de sistema
-- ao lado da política de tenant existente não afrouxa nada para o app_user.
-- `subscriptions` é o caso que mais precisa disso: a única política dela era
-- FOR SELECT, e sob FORCE o webhook e a reconciliação (que rodam como dono)
-- não teriam política alguma que permitisse escrever.
CREATE POLICY workspace_members_system ON workspace_members
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY invites_system ON invites
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY users_system ON users
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY sessions_system ON sessions
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY subscriptions_system ON subscriptions
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY products_system ON products
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY stock_movements_system ON stock_movements
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY sync_operations_system ON sync_operations
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY initial_uploads_system ON initial_uploads
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY initial_upload_batches_system ON initial_upload_batches
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY sync_cursors_system ON sync_cursors
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

CREATE POLICY conflict_log_system ON conflict_log
  USING (app_is_system_context()) WITH CHECK (app_is_system_context());

-- ---------------------------------------------------------------------------
-- A-10 — `users` e `sessions` deixam de ser graváveis por inteiro
--
-- O GRANT de 0002 cobria todas as colunas, e as políticas não tinham WITH
-- CHECK — o Postgres então reaproveita o USING como checagem de escrita, e
-- toda linha de um colega de empresa satisfaz o USING. Somado, isso significa
-- que a sessão de um membro "somente consulta" podia, no nível do banco,
-- reescrever o password_hash ou o e-mail de um colega.
--
-- O que a aplicação realmente faz com essas tabelas dentro de `withTenant` é
-- pouco e específico:
--   users    -> lê id/name/email na listagem de membros e na checagem de
--               convite; incrementa permission_version ao mudar papel,
--               remover ou suspender alguém (o incremento lê a coluna, por
--               isso ela também aparece no SELECT);
--   sessions -> derruba as sessões de quem foi removido ou suspenso.
-- Qualquer coluna nova exigida por um caminho de tenant precisa de um GRANT
-- explícito aqui; é o preço de o banco não ser mais um cheque em branco.
-- ---------------------------------------------------------------------------

REVOKE ALL ON users FROM app_user;
GRANT SELECT (id, name, email, status, permission_version) ON users TO app_user;
GRANT UPDATE (permission_version) ON users TO app_user;

REVOKE ALL ON sessions FROM app_user;
GRANT SELECT (id, user_id, revoked_at) ON sessions TO app_user;
GRANT UPDATE (revoked_at, revoked_reason) ON sessions TO app_user;

DROP POLICY users_tenant_scope ON users;

CREATE POLICY users_tenant_scope ON users
  USING (
    id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = users.id
    )
  )
  -- Explícito para não depender do reaproveitamento do USING: a linha
  -- resultante precisa continuar pertencendo a alguém da empresa corrente.
  WITH CHECK (
    id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = users.id
    )
  );

DROP POLICY sessions_tenant_scope ON sessions;

CREATE POLICY sessions_tenant_scope ON sessions
  USING (
    user_id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = sessions.user_id
    )
  )
  -- A única escrita legítima de um tenant em `sessions` é encerrar sessões.
  -- Exigir revoked_at preenchido impede o caminho inverso: reativar a sessão
  -- de um colega a partir de uma transação de tenant.
  WITH CHECK (
    revoked_at IS NOT NULL
    AND (
      user_id = app_current_user()
      OR EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = app_current_workspace()
          AND wm.user_id = sessions.user_id
      )
    )
  );

-- ---------------------------------------------------------------------------
-- A-08 — chaves estrangeiras escopadas por empresa
--
-- A checagem de integridade referencial ignora RLS, aconteça o que acontecer
-- com o papel corrente. Como `products` era referenciada só por `id`, um
-- tenant conseguia inserir uma movimentação apontando para o produto de outra
-- empresa: o WITH CHECK de stock_movements valida o workspace_id da própria
-- linha nova, e nada sobre o que product_id referencia. O estrago ficava
-- invisível — o gatilho de saldo roda como app_user, o UPDATE em products é
-- filtrado pela política, casa zero linhas e a operação responde sucesso.
--
-- Com a chave composta, a referência cruzada deixa de ser representável.
-- ---------------------------------------------------------------------------

ALTER TABLE products
  ADD CONSTRAINT products_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE initial_uploads
  ADD CONSTRAINT initial_uploads_workspace_id_unique UNIQUE (workspace_id, id);

-- A lista de colunas no ON DELETE SET NULL é obrigatória: sem ela o Postgres
-- anularia também o workspace_id, que é NOT NULL, e a limpeza de lápides
-- passaria a falhar ao apagar um produto.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_product_id_fkey;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_product_fk
  FOREIGN KEY (workspace_id, product_id) REFERENCES products (workspace_id, id)
  ON DELETE SET NULL (product_id);

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reverses_movement_id_fkey;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_reverses_fk
  FOREIGN KEY (workspace_id, reverses_movement_id) REFERENCES stock_movements (workspace_id, id)
  ON DELETE SET NULL (reverses_movement_id);

ALTER TABLE initial_upload_batches DROP CONSTRAINT IF EXISTS initial_upload_batches_upload_id_fkey;
ALTER TABLE initial_upload_batches
  ADD CONSTRAINT initial_upload_batches_upload_fk
  FOREIGN KEY (workspace_id, upload_id) REFERENCES initial_uploads (workspace_id, id)
  ON DELETE CASCADE;

-- `sync_cursors.device_id` continua global: `devices` pertence ao usuário, não
-- à empresa (o mesmo aparelho sincroniza empresas diferentes), então não há
-- workspace_id do outro lado para compor a chave. O escopo dessa tabela é
-- garantido pela chave primária (workspace_id, device_id) mais a política.

-- Mesmo com a chave composta, o gatilho de saldo passa a filtrar pela empresa
-- da movimentação. Um UPDATE de saldo que dependa apenas do id do produto é
-- frágil demais para uma projeção que ninguém confere depois.
CREATE OR REPLACE FUNCTION apply_movement_to_balance() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.carga_inicial', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    UPDATE products
       SET quantity_cache = quantity_cache + NEW.quantity
     WHERE id = NEW.product_id
       AND workspace_id = NEW.workspace_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- M-24 — unicidade de nome de empresa deixa de ser TOCTOU
--
-- A verificação de disponibilidade roda fora da transação que cria a empresa,
-- e não havia índice sustentando a regra: dois toques simultâneos no botão
-- criavam duas empresas com o mesmo nome. O índice é parcial em deleted_at
-- para que excluir uma empresa libere o nome de volta.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX workspaces_owner_nome_unico_idx
  ON workspaces (owner_user_id, lower(name))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- M-01 — índices
-- ---------------------------------------------------------------------------

-- `workspaces.owner_user_id` é ON DELETE RESTRICT, e um índice parcial não
-- serve para a checagem de integridade referencial: apagar um usuário fazia
-- varredura sequencial em workspaces. O índice pleno também cobre tudo o que o
-- parcial cobria, então o parcial sai.
CREATE INDEX workspaces_owner_fk_idx ON workspaces (owner_user_id);
DROP INDEX IF EXISTS workspaces_owner_idx;

-- devices_user_idx era (user_id) WHERE revoked_at IS NULL, prefixo do índice
-- único (user_id, install_id), que é pleno e serve inclusive a checagem do
-- ON DELETE CASCADE vindo de users.
DROP INDEX IF EXISTS devices_user_idx;

-- workspace_members_workspace_idx era (workspace_id, status), prefixo do único
-- (workspace_id, user_id). workspace_members_user_idx continua, porque é ele
-- que atende a listagem de empresas do usuário e as políticas de users/sessions.
DROP INDEX IF EXISTS workspace_members_workspace_idx;

-- Sobre `stock_movements (product_id)`: com a chave estrangeira composta desta
-- migration, a checagem de integridade referencial passa a consultar
-- (workspace_id, product_id), que é exatamente o prefixo de
-- stock_movements_produto_idx. Um índice só em product_id seria peso morto na
-- tabela que mais recebe escrita, então não foi criado.

-- ---------------------------------------------------------------------------
-- M-26 — restrições de quantidade
-- ---------------------------------------------------------------------------

-- Estoque mínimo negativo não tem significado, e o app já valida isso na
-- entrada; a restrição é validada porque não deve existir linha assim.
ALTER TABLE products
  ADD CONSTRAINT products_min_stock_check CHECK (min_stock >= 0);

-- Movimentação de quantidade zero não é um fato: não entrou nem saiu nada.
-- NOT VALID porque a carga inicial aceita hoje o que o aparelho mandar, e um
-- histórico legado com um zero não pode impedir o deploy da restrição — as
-- linhas novas passam a ser checadas de imediato.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_quantity_check CHECK (quantity <> 0) NOT VALID;

-- Saldo negativo, ao contrário, é legítimo e não ganha restrição: num app
-- offline-first as movimentações chegam fora de ordem, e a saída de hoje pode
-- ser recebida antes da entrada de ontem. Recusar o saldo negativo faria o
-- servidor rejeitar um dado verdadeiro por causa da ordem de chegada.
COMMENT ON COLUMN products.quantity_cache IS
  'Projeção do saldo. Pode ser negativa de propósito: as movimentações chegam fora de '
  'ordem no modo offline, e o saldo se acerta quando o restante do lote sobe.';
