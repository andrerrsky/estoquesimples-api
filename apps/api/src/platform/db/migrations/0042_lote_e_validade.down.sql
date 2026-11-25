DROP INDEX IF EXISTS stock_movements_validade_idx;
ALTER TABLE stock_movements
  DROP COLUMN IF EXISTS expires_on,
  DROP COLUMN IF EXISTS manufactured_on,
  DROP COLUMN IF EXISTS batch_code;
