-- Reverte a Fase 6.

DROP POLICY IF EXISTS initial_upload_batches_tenant ON initial_upload_batches;
DROP POLICY IF EXISTS initial_uploads_tenant ON initial_uploads;
DROP POLICY IF EXISTS sync_operations_tenant ON sync_operations;
DROP POLICY IF EXISTS stock_movements_tenant ON stock_movements;
DROP POLICY IF EXISTS products_tenant ON products;

ALTER TABLE workspaces DROP COLUMN IF EXISTS seeded_at;

DROP TABLE IF EXISTS initial_upload_batches;
DROP TABLE IF EXISTS initial_uploads;
DROP TABLE IF EXISTS sync_operations;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS products;
