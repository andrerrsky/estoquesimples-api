-- Agendamento de campanha de push.
--
-- A fila de tarefas já sabe esperar (`jobs.run_at`), então agendar é
-- enfileirar o envio com a hora certa. A coluna aqui existe para o painel
-- poder mostrar "sai às 10h de amanhã" e para o cancelamento saber o que
-- está marcado — sem ela, a informação viveria só dentro da fila.
ALTER TABLE push_campaigns ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

-- Campanhas marcadas para o futuro, para a listagem do painel não varrer a
-- tabela inteira à procura delas.
CREATE INDEX IF NOT EXISTS push_campaigns_scheduled_idx
  ON push_campaigns (scheduled_at)
  WHERE status = 'scheduled';

-- 'scheduled' é uma situação nova: sem soltar o CHECK de 0011 o UPDATE falha.
ALTER TABLE push_campaigns DROP CONSTRAINT IF EXISTS push_campaigns_status_check;
ALTER TABLE push_campaigns ADD CONSTRAINT push_campaigns_status_check
  CHECK (status IN ('draft', 'scheduled', 'queued', 'sending', 'sent', 'failed', 'cancelled'));
