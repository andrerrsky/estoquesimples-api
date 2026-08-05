DROP TRIGGER IF EXISTS stock_movements_atualiza_saldo ON stock_movements;
DROP FUNCTION IF EXISTS apply_movement_to_balance();

DROP TABLE IF EXISTS sync_cursors;

ALTER TABLE workspaces DROP COLUMN IF EXISTS tombstone_horizon_seq;
