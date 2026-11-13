-- 0037 — índices para a conferência de saldo.
--
-- A conferência pagina por `id` (e não por `change_seq`) para percorrer o
-- catálogo inteiro sem repetir nem pular linha quando algo muda no meio. Os
-- índices existentes são por `(workspace_id, change_seq)`, então cada página
-- custava ordenar o conjunto todo da empresa — numa conta com milhares de
-- produtos, uma leitura cara repetida a cada página.

CREATE INDEX IF NOT EXISTS stock_products_workspace_id_idx
  ON products (workspace_id, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS stock_movements_workspace_product_id_idx
  ON stock_movements (workspace_id, product_id, id);

-- A movimentação que chegou antes do produto é reconhecida pelo vínculo
-- pretendido; sem este índice ela custaria uma varredura por produto
-- conferido.
CREATE INDEX IF NOT EXISTS stock_movements_workspace_intended_id_idx
  ON stock_movements (workspace_id, intended_product_id, id)
  WHERE product_id IS NULL AND intended_product_id IS NOT NULL;
