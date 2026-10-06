DELETE FROM plan_features WHERE feature_key = 'imagens.armazenamento_mb';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_photo_hash_check;
DROP TABLE IF EXISTS workspace_images;
