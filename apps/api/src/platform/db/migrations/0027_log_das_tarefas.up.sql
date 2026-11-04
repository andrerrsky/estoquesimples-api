-- Log de cada execução da fila (estilo Jenkins): o painel mostra, numa página
-- própria da tarefa, cada tentativa com início, passos, erro e fim, sem
-- depender de a tarefa ainda estar "em execução". Sai junto com a tarefa.
CREATE TABLE job_logs (
  id         bigserial   PRIMARY KEY,
  job_id     uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt    integer     NOT NULL,
  level      text        NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_logs_job_idx ON job_logs (job_id, id);
CREATE INDEX job_logs_created_idx ON job_logs (created_at);

-- O que a tarefa produziu (ex.: o post que a IA escreveu), para o painel
-- oferecer o atalho ao fim da execução.
ALTER TABLE jobs ADD COLUMN result jsonb;
