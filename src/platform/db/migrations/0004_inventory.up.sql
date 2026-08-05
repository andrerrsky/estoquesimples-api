-- Fase 6: o estoque no servidor e a infraestrutura de sincronização.

-- ---------------------------------------------------------------------------
-- Produtos
--
-- A chave primária é o UUID gerado no aparelho, antes de qualquer conexão.
-- Essa é a decisão que sustenta o modo offline inteiro: o cliente pode criar
-- registros sem rede, e reenviar o mesmo registro quantas vezes for preciso
-- sem duplicar nada, porque a segunda inserção colide na chave.
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id             uuid        PRIMARY KEY,
  workspace_id   uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,

  name           text        NOT NULL,
  description    text,
  unit_value     numeric(14, 4) NOT NULL DEFAULT 0,
  -- Projeção do saldo, atualizada na mesma transação que insere o movimento.
  -- A fonte de verdade é a soma de stock_movements; este campo existe porque
  -- somar o histórico inteiro a cada listagem não escala.
  quantity_cache numeric(14, 4) NOT NULL DEFAULT 0,
  min_stock      numeric(14, 4) NOT NULL DEFAULT 0,
  unit           text,
  category       text,
  supplier       text,
  location       text,
  sku            text,
  barcode        text,
  -- Só o hash: a imagem em si não trafega na sincronização de dados.
  photo_hash     text,

  -- Contador de versão do registro. É o que permite detectar que dois
  -- aparelhos partiram da mesma versão e editaram o mesmo produto.
  rev            integer     NOT NULL DEFAULT 0,
  -- Posição na sequência de alterações da empresa; define a ordem de leitura.
  change_seq     bigint      NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Exclusão lógica: o registro vira lápide e continua sendo entregue aos
  -- outros aparelhos. Apagar a linha faria a exclusão nunca se propagar.
  deleted_at     timestamptz,
  deleted_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  last_op_id     uuid
);

CREATE INDEX products_sync_idx ON products (workspace_id, change_seq);
CREATE INDEX products_workspace_idx ON products (workspace_id) WHERE deleted_at IS NULL;

-- Nomes repetidos são impedidos aqui e não no aparelho: o banco antigo dos
-- usuários está cheio deles, e recusar a carga inicial por isso deixaria as
-- pessoas sem saída. O índice é parcial para que um produto excluído libere
-- o nome de volta.
CREATE UNIQUE INDEX products_nome_unico_idx
  ON products (workspace_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Movimentações
--
-- Cada linha é um fato que aconteceu e nunca é alterada. Um erro se corrige
-- com um movimento compensatório apontando para o original, e não editando ou
-- apagando o registro: o saldo precisa continuar explicável pela soma dos
-- eventos, senão o histórico deixa de ser auditável.
-- ---------------------------------------------------------------------------

CREATE TABLE stock_movements (
  id                   uuid        PRIMARY KEY,
  workspace_id         uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Nulo é permitido: o histórico legado dos aparelhos tem movimentações de
  -- produtos que foram renomeados ou apagados antes de existirem UUIDs.
  -- Descartá-las na importação apagaria histórico real do usuário.
  product_id           uuid        REFERENCES products (id) ON DELETE SET NULL,
  product_name         text,

  type                 text        NOT NULL,
  -- Com sinal: o efeito no saldo é lido direto, sem depender de interpretar
  -- o tipo em cada consulta.
  quantity             numeric(14, 4) NOT NULL,
  note                 text,

  -- Relógio do aparelho, informativo. Pode estar errado e não ordena nada.
  occurred_at          timestamptz NOT NULL,
  -- Relógio do servidor, esse sim confiável.
  recorded_at          timestamptz NOT NULL DEFAULT now(),

  reverses_movement_id uuid        REFERENCES stock_movements (id) ON DELETE SET NULL,
  created_by           uuid        REFERENCES users (id) ON DELETE SET NULL,
  device_id            uuid        REFERENCES devices (id) ON DELETE SET NULL,

  change_seq           bigint      NOT NULL,
  op_id                uuid
);

CREATE INDEX stock_movements_sync_idx ON stock_movements (workspace_id, change_seq);
CREATE INDEX stock_movements_produto_idx
  ON stock_movements (workspace_id, product_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Operações de sincronização
--
-- Guarda o resultado de cada operação recebida. Existe por causa de um caso
-- específico e inevitável: a operação é aplicada, o servidor responde, e a
-- resposta se perde no caminho. O aparelho reenvia, porque para ele nada
-- aconteceu. Sem este registro, a operação seria aplicada duas vezes — e uma
-- saída de estoque cobrada em dobro não tem como ser detectada depois.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_operations (
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  op_id        uuid        NOT NULL,
  device_id    uuid        REFERENCES devices (id) ON DELETE SET NULL,
  entity_type  text        NOT NULL,
  entity_id    uuid        NOT NULL,
  status       text        NOT NULL,
  result       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, op_id)
);

CREATE INDEX sync_operations_limpeza_idx ON sync_operations (created_at);

-- ---------------------------------------------------------------------------
-- Sessões de carga inicial
--
-- A primeira carga são milhares de registros saindo de um celular por rede
-- móvel; interrupção é o caso comum. A sessão guarda o que foi declarado e o
-- que chegou, para que a conclusão possa comparar os dois números em vez de
-- confiar que tudo passou.
-- ---------------------------------------------------------------------------

CREATE TABLE initial_uploads (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id          uuid        REFERENCES devices (id) ON DELETE SET NULL,

  declared_products  integer     NOT NULL,
  declared_movements integer     NOT NULL,
  received_products  integer     NOT NULL DEFAULT 0,
  received_movements integer     NOT NULL DEFAULT 0,

  status             text        NOT NULL DEFAULT 'em_andamento',
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,

  CONSTRAINT initial_uploads_status_valido
    CHECK (status IN ('em_andamento', 'concluida', 'abandonada'))
);

-- Uma sessão aberta por empresa. Duas cargas iniciais simultâneas disputariam
-- os mesmos registros e a contagem final não fecharia em nenhuma das duas.
CREATE UNIQUE INDEX initial_uploads_uma_aberta_idx
  ON initial_uploads (workspace_id)
  WHERE status = 'em_andamento';

-- Lotes já processados, para que o reenvio de um lote seja um nada-a-fazer
-- explícito em vez de uma reaplicação.
CREATE TABLE initial_upload_batches (
  upload_id    uuid        NOT NULL REFERENCES initial_uploads (id) ON DELETE CASCADE,
  -- Repetido aqui apenas para que a política de isolamento possa ser aplicada.
  -- RLS não atravessa chave estrangeira: sem a coluna, esta tabela seria a
  -- única do conjunto legível por qualquer empresa.
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  batch_index  integer     NOT NULL,
  products     integer     NOT NULL DEFAULT 0,
  movements    integer     NOT NULL DEFAULT 0,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, batch_index)
);

-- Marca que a empresa já recebeu a carga inicial. Sem isso, um segundo
-- aparelho recém-instalado enviaria o próprio banco por cima do que já está
-- na nuvem, em vez de baixar o que existe.
ALTER TABLE workspaces ADD COLUMN seeded_at timestamptz;

-- ---------------------------------------------------------------------------
-- Isolamento entre empresas
--
-- As políticas repetem a mesma condição porque é isso que garante que um erro
-- de `WHERE` numa consulta não vaze dados de outra empresa. A checagem fica no
-- banco, abaixo de qualquer código de aplicação.
-- ---------------------------------------------------------------------------

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE initial_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE initial_upload_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_tenant ON products
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

CREATE POLICY stock_movements_tenant ON stock_movements
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

CREATE POLICY sync_operations_tenant ON sync_operations
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

CREATE POLICY initial_uploads_tenant ON initial_uploads
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

CREATE POLICY initial_upload_batches_tenant ON initial_upload_batches
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

GRANT SELECT, INSERT, UPDATE, DELETE ON products TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_movements TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_operations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON initial_uploads TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON initial_upload_batches TO app_user;
