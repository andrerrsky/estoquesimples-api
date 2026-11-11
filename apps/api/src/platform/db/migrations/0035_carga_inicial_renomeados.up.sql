-- Produtos que a carga inicial gravou com outro nome porque o nome já existia
-- na empresa ("Café" e "café" no mesmo aparelho). Ao concluir, eles ganham uma
-- posição nova na sequência de alterações para o aparelho receber o nome final.
ALTER TABLE initial_uploads
  ADD COLUMN IF NOT EXISTS renamed_product_ids uuid[] NOT NULL DEFAULT '{}';
