-- Reverte a Fase 9.
--
-- A ordem importa: as políticas precisam sair antes de app_is_system_context(),
-- que elas referenciam, e os GRANTs por coluna precisam ser revogados antes de
-- devolver o GRANT amplo — REVOKE ALL cobre os dois casos.

-- M-26 — restrições de quantidade.
COMMENT ON COLUMN products.quantity_cache IS NULL;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_quantity_check;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_min_stock_check;

-- M-01 / M-24 — índices.
DROP INDEX IF EXISTS workspaces_owner_nome_unico_idx;
DROP INDEX IF EXISTS workspaces_owner_fk_idx;
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_members_workspace_idx ON workspace_members (workspace_id, status);

-- A-08 — chaves estrangeiras voltam a ser globais.
CREATE OR REPLACE FUNCTION apply_movement_to_balance() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.carga_inicial', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    UPDATE products
       SET quantity_cache = quantity_cache + NEW.quantity
     WHERE id = NEW.product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE initial_upload_batches DROP CONSTRAINT IF EXISTS initial_upload_batches_upload_fk;
ALTER TABLE initial_upload_batches
  ADD CONSTRAINT initial_upload_batches_upload_id_fkey
  FOREIGN KEY (upload_id) REFERENCES initial_uploads (id) ON DELETE CASCADE;

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reverses_fk;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_reverses_movement_id_fkey
  FOREIGN KEY (reverses_movement_id) REFERENCES stock_movements (id) ON DELETE SET NULL;

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_product_fk;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL;

ALTER TABLE initial_uploads DROP CONSTRAINT IF EXISTS initial_uploads_workspace_id_unique;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_workspace_id_unique;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_workspace_id_unique;

-- A-10 — `users` e `sessions` voltam às políticas e aos GRANTs de 0002.
DROP POLICY IF EXISTS sessions_tenant_scope ON sessions;
CREATE POLICY sessions_tenant_scope ON sessions
  USING (
    user_id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = sessions.user_id
    )
  );

DROP POLICY IF EXISTS users_tenant_scope ON users;
CREATE POLICY users_tenant_scope ON users
  USING (
    id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = app_current_workspace()
        AND wm.user_id = users.id
    )
  );

REVOKE ALL ON users FROM app_user;
REVOKE ALL ON sessions FROM app_user;
GRANT SELECT, UPDATE ON users TO app_user;
GRANT SELECT, UPDATE ON sessions TO app_user;

-- A-11 — políticas de sistema e FORCE.
DROP POLICY IF EXISTS conflict_log_system ON conflict_log;
DROP POLICY IF EXISTS sync_cursors_system ON sync_cursors;
DROP POLICY IF EXISTS initial_upload_batches_system ON initial_upload_batches;
DROP POLICY IF EXISTS initial_uploads_system ON initial_uploads;
DROP POLICY IF EXISTS sync_operations_system ON sync_operations;
DROP POLICY IF EXISTS stock_movements_system ON stock_movements;
DROP POLICY IF EXISTS products_system ON products;
DROP POLICY IF EXISTS subscriptions_system ON subscriptions;
DROP POLICY IF EXISTS sessions_system ON sessions;
DROP POLICY IF EXISTS users_system ON users;
DROP POLICY IF EXISTS invites_system ON invites;
DROP POLICY IF EXISTS workspace_members_system ON workspace_members;

ALTER TABLE conflict_log           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE initial_upload_batches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE initial_uploads        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_operations        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE products               NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions               NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users                  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invites                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_members      NO FORCE ROW LEVEL SECURITY;

-- C-03 — audit_log volta a não ter RLS.
COMMENT ON CONSTRAINT audit_log_workspace_fk ON audit_log IS NULL;
DROP POLICY IF EXISTS audit_log_system ON audit_log;
DROP POLICY IF EXISTS audit_log_tenant ON audit_log;
ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

-- C-02 — next_change_seq volta a ser SECURITY INVOKER e pública.
CREATE OR REPLACE FUNCTION next_change_seq(target_workspace uuid) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY INVOKER
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

ALTER FUNCTION next_change_seq(uuid) RESET search_path;
GRANT EXECUTE ON FUNCTION next_change_seq(uuid) TO PUBLIC;

-- C-02 — workspaces volta a não ter RLS e ao GRANT amplo.
DROP POLICY IF EXISTS workspaces_system ON workspaces;
DROP POLICY IF EXISTS workspaces_tenant ON workspaces;
ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON workspaces FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces TO app_user;

DROP FUNCTION IF EXISTS app_is_system_context();
