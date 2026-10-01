-- 0014 — saldo de produtos criados pela sincronização incremental.
--
-- Até aqui, um produto novo enviado pelo app chegava com a quantidade no
-- cadastro E com a movimentação de `cadastro`/`importacao` que a explica, e o
-- gatilho de saldo somava a segunda por cima da primeira: o saldo na nuvem
-- ficava em dobro. A API passou a criar o produto com saldo zero e deixar as
-- movimentações formarem o saldo; esta migration corrige o que já foi gravado.
--
-- Só são tocados os produtos que nasceram pela sincronização incremental —
-- reconhecíveis por terem a movimentação de saldo inicial com `op_id`
-- (a carga inicial grava movimentações sem `op_id`, e nela o saldo vem pronto
-- do aparelho, com histórico incompleto, e precisa continuar como está).
-- Para esses, todo o histórico subiu pela mesma via, então o saldo correto é
-- a soma das movimentações. Os aparelhos não precisam reler: eles ignoram a
-- quantidade de produtos que já conhecem (o saldo local vem das movimentações).

WITH nascidos_no_push AS (
  SELECT DISTINCT m.workspace_id, m.product_id
  FROM stock_movements m
  WHERE m.op_id IS NOT NULL
    AND m.product_id IS NOT NULL
    AND m.type IN ('cadastro', 'importacao')
),
saldos AS (
  SELECT m.workspace_id, m.product_id, sum(m.quantity) AS total
  FROM stock_movements m
  JOIN nascidos_no_push n ON n.workspace_id = m.workspace_id AND n.product_id = m.product_id
  GROUP BY m.workspace_id, m.product_id
)
UPDATE products p
SET quantity_cache = s.total
FROM saldos s
WHERE p.workspace_id = s.workspace_id
  AND p.id = s.product_id
  AND p.quantity_cache <> s.total;
