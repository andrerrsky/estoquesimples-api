DELETE FROM plan_features WHERE feature_key IN ('produtos.sincronizados', 'analise.avancada');
UPDATE plan_features SET enabled = false, limit_value = NULL WHERE plan_key = 'gratuito' AND feature_key = 'sync.nuvem';
DELETE FROM plan_features WHERE plan_key = 'gratuito' AND feature_key = 'sync.dispositivos';
UPDATE plans SET name = 'Gratuito', description = 'Uso local no aparelho, sem sincronização.' WHERE key = 'gratuito';
UPDATE plans SET name = 'Básico', description = 'Sincronização em nuvem e equipe.' WHERE key = 'basico';
