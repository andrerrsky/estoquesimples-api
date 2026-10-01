-- 0013 — sincronização em nuvem passa a ser grátis para quem tem conta.
--
-- Antes: o plano gratuito era "só o aparelho" e qualquer uso da nuvem exigia
-- a assinatura. Agora criar conta já libera a nuvem para a própria pessoa,
-- com teto de produtos; a assinatura passa a vender equipe, produtos sem
-- limite e a Análise Avançada. Os números vivem em plan_features e podem ser
-- ajustados pelo painel sem deploy.
--
-- Chaves de recurso:
--   sync.nuvem              a empresa pode sincronizar (liga/desliga por plano)
--   produtos.sincronizados  teto de produtos vivos na nuvem (NULL = sem limite)
--   equipe.membros          membros além do proprietário (limit = total, NULL = sem limite)
--   sync.dispositivos       aparelhos (não aplicado; documental)
--   analise.avancada        Análise Avançada de Estoque no app

UPDATE plans SET
  name = 'Gratuito',
  description = 'Conta grátis: seus dados na nuvem, em todos os seus aparelhos, com até 50 produtos.'
WHERE key = 'gratuito';

UPDATE plans SET
  name = 'Equipe',
  description = 'Equipe trabalhando no mesmo estoque, produtos sem limite e Análise Avançada.'
WHERE key = 'basico';

INSERT INTO plan_features (plan_key, feature_key, enabled, limit_value) VALUES
  ('gratuito', 'sync.nuvem',             true,  NULL),
  ('gratuito', 'produtos.sincronizados', true,  50),
  ('gratuito', 'equipe.membros',         false, 1),
  ('gratuito', 'sync.dispositivos',      true,  NULL),
  ('gratuito', 'analise.avancada',       false, NULL),
  ('basico',   'sync.nuvem',             true,  NULL),
  ('basico',   'produtos.sincronizados', true,  NULL),
  ('basico',   'equipe.membros',         true,  NULL),
  ('basico',   'sync.dispositivos',      true,  NULL),
  ('basico',   'analise.avancada',       true,  NULL)
ON CONFLICT (plan_key, feature_key) DO UPDATE
  SET enabled = EXCLUDED.enabled, limit_value = EXCLUDED.limit_value;
