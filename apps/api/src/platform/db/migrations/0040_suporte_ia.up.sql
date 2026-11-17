-- Resposta automática por IA no suporte.
--
-- Duas marcas novas, e nenhuma tabela: o que a IA faz continua sendo uma
-- mensagem comum da conversa (o app, a web e o painel já sabem mostrá-la).
--
-- `needs_human` é o que a IA devolve quando não sabe responder ou quando a
-- resposta depende de uma pessoa (reembolso, cobrança, bug). Vive no ticket,
-- e não numa mensagem, porque é um estado da solicitação: o painel filtra por
-- ele e o aviso por e-mail ao dono sai uma vez só — é esta coluna que garante
-- isso, já que a chave única da fila só vale enquanto a tarefa está pendente.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS needs_human boolean NOT NULL DEFAULT false;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS needs_human_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS needs_human_reason text;

-- A fila do painel pergunta "o que precisa de mim?" com frequência; o índice
-- parcial é pequeno porque a maioria das solicitações nunca é marcada.
CREATE INDEX IF NOT EXISTS support_tickets_needs_human_idx
  ON support_tickets (last_message_at DESC)
  WHERE needs_human;

-- Quem escreveu a mensagem: a IA ou uma pessoa. O painel mostra a etiqueta,
-- o chat da web usa a marca para revelar o texto no ritmo de digitação, e a
-- regra "se um humano já respondeu, a IA não responde mais" se apoia nela.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS ai boolean NOT NULL DEFAULT false;
