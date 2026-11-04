-- Fila de tarefas: em que passo uma tarefa longa está (a IA escrevendo um
-- post, por exemplo), para o painel mostrar o que roda agora; e falhas
-- descartadas pelo painel, que saem da lista sem virar repetição.
ALTER TABLE jobs ADD COLUMN progress text;
ALTER TABLE jobs ADD COLUMN progress_at timestamptz;
ALTER TABLE jobs ADD COLUMN dismissed_at timestamptz;
ALTER TABLE jobs ADD COLUMN dismissed_by text;
