-- Navegador/app de quem fez cada ação, nas duas trilhas de auditoria (clientes e painel).
ALTER TABLE audit_log ADD COLUMN user_agent text;
ALTER TABLE admin_audit_log ADD COLUMN user_agent text;
