DELETE FROM plan_features WHERE feature_key = 'marca.personalizada';
DELETE FROM role_permissions WHERE permission_key = 'marca.gerenciar';
DELETE FROM permissions WHERE key = 'marca.gerenciar';
DROP TABLE IF EXISTS brand_slug_reservations;
DROP TABLE IF EXISTS workspace_brandings;
