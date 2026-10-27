-- 0025 — movimentação que chega antes do produto guarda para qual produto veio.
--
-- A fila do app podia enviar a movimentação de cadastro antes do próprio
-- produto: a compactação da fila mantinha a edição mais recente do produto e
-- descartava o cadastro original, que estava na frente das movimentações.
-- A movimentação era gravada órfã (product_id nulo, como uma movimentação de
-- produto apagado) e o produto nascia em seguida com saldo zero. A primeira
-- saída deixava a nuvem negativa enquanto o aparelho, que tem o histórico
-- inteiro, mostrava o saldo certo.
--
-- Com a coluna, a movimentação órfã lembra o produto pretendido; quando ele é
-- criado, a API a vincula e soma ao saldo (ver SyncService.upsertProduto).
-- As órfãs já gravadas não têm essa informação: o script
-- scripts/reparar-movimentacoes-orfas.ts as encontra pelo nome, para revisão.
ALTER TABLE stock_movements ADD COLUMN intended_product_id uuid;

COMMENT ON COLUMN stock_movements.intended_product_id IS
  'Produto que a movimentação pretendia, quando chegou antes dele. Limpo ao vincular.';

CREATE INDEX stock_movements_pretendido_idx
  ON stock_movements (workspace_id, intended_product_id)
  WHERE product_id IS NULL AND intended_product_id IS NOT NULL;
