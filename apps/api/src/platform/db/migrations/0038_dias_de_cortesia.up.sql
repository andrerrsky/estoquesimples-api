-- Dias de cortesia concedidos pelo painel administrativo.
--
-- Existe para resolver pelo produto o que hoje só se resolve pelo reembolso:
-- quando falhamos com um cliente, podemos devolver tempo em vez de dinheiro —
-- e tempo mantém o cliente, enquanto o reembolso o encerra.
--
-- Cada concessão é uma linha, nunca uma coluna mexida na assinatura. Três
-- motivos: a assinatura é espelho do que o Google ou o Asaas dizem (escrever
-- nela seria perder o acerto na próxima reconciliação), o histórico de quem
-- deu, quando e por quê precisa sobreviver, e uma concessão feita por engano
-- tem que poder ser desfeita sem apagar o rastro.
--
-- Tabela de sistema, como subscriptions e coupons: sem GRANT para app_user,
-- lida só pelos caminhos da API que rodam fora de withTenant.

CREATE TABLE courtesy_grants (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Plano que vale durante a cortesia. Guardado por extenso porque o plano de
  -- hoje pode deixar de existir, e o que foi prometido tem que continuar valendo.
  plan_key     text        NOT NULL REFERENCES plans (key) ON DELETE RESTRICT,
  days         integer     NOT NULL,
  -- Calculados na concessão: a cortesia começa onde o acesso já garantido
  -- termina (fim do período pago, carência, ou outra cortesia ainda vigente),
  -- de modo que "mais 30 dias" seja mesmo 30 dias a mais, e não 30 dias
  -- sobrepostos ao que a pessoa já tinha.
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  -- Por que foi dada. Aparece na ficha da empresa e no histórico.
  reason       text,
  granted_by   uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  revoked_by   uuid        REFERENCES platform_admins (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courtesy_grants_days_check   CHECK (days BETWEEN 1 AND 365),
  CONSTRAINT courtesy_grants_period_check CHECK (ends_at > starts_at),
  CONSTRAINT courtesy_grants_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR revoked_at IS NOT NULL
  )
);

-- A pergunta que o cálculo de direitos faz a cada chamada: qual é a cortesia
-- vigente desta empresa? Parcial, porque a revogada não interessa mais.
CREATE INDEX courtesy_grants_vigentes_idx
  ON courtesy_grants (workspace_id, ends_at DESC)
  WHERE revoked_at IS NULL;
