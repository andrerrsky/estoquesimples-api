-- Fase 8: registro e resolução de conflitos.

-- ---------------------------------------------------------------------------
-- Conflitos
--
-- Existe por uma regra só: nenhuma estratégia de resolução pode descartar
-- dado sem deixar rastro. Quando dois aparelhos alteram o mesmo campo, um dos
-- valores não vai prevalecer — e a pessoa que digitou aquele valor precisa
-- poder encontrá-lo depois, mesmo que a decisão automática tenha sido a certa.
--
-- Guarda os três lados da história: o que estava antes (`base_value`), o que
-- prevaleceu (`kept_value`) e o que foi descartado (`discarded_value`). Só com
-- os três é possível reconstruir a decisão em vez de confiar nela.
-- ---------------------------------------------------------------------------

CREATE TABLE conflict_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,

  entity_type     text        NOT NULL,
  entity_id       uuid        NOT NULL,
  -- Nulo quando o conflito é do registro inteiro, e não de um campo.
  field           text,

  kind            text        NOT NULL,
  status          text        NOT NULL,

  base_value      jsonb,
  kept_value      jsonb,
  discarded_value jsonb,

  op_id           uuid,
  device_id       uuid        REFERENCES devices (id) ON DELETE SET NULL,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  resolved_at     timestamptz,
  resolved_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  resolution      text,

  CONSTRAINT conflict_log_kind_valido
    CHECK (kind IN ('campo', 'exclusao_vs_edicao')),
  -- `automatico` é o conflito que o servidor resolveu sozinho e fica apenas
  -- para consulta; `pendente` é o que espera uma decisão de gente.
  CONSTRAINT conflict_log_status_valido
    CHECK (status IN ('automatico', 'pendente', 'resolvido')),
  CONSTRAINT conflict_log_resolucao_valida
    CHECK (resolution IS NULL OR resolution IN ('meu', 'servidor', 'restaurar'))
);

CREATE INDEX conflict_log_pendentes_idx
  ON conflict_log (workspace_id, created_at DESC)
  WHERE status = 'pendente';

CREATE INDEX conflict_log_entidade_idx
  ON conflict_log (workspace_id, entity_type, entity_id);

ALTER TABLE conflict_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY conflict_log_tenant ON conflict_log
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

GRANT SELECT, INSERT, UPDATE, DELETE ON conflict_log TO app_user;
