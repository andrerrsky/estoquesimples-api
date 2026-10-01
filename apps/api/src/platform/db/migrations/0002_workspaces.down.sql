ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_workspace_fk;

DROP POLICY IF EXISTS sessions_tenant_scope ON sessions;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_scope ON users;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON users, sessions FROM app_user;

DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;

DROP FUNCTION IF EXISTS next_change_seq(uuid);

DROP TABLE IF EXISTS workspaces;
