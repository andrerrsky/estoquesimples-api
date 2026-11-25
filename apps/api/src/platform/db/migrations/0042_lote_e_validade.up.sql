-- Lote, fabricação e validade.
--
-- Pedido de quem trabalha com alimento (solicitação #1011, empresa de
-- biscoitos): o mesmo produto chega em lotes diferentes, cada um com a sua
-- validade. O caminho fácil seria uma tabela de lotes com quantidade própria,
-- mas aí o estoque passaria a ter duas verdades — a soma das movimentações e
-- a soma dos lotes — que divergem no primeiro conflito de sincronização.
--
-- Por isso o lote é **atributo da movimentação**, não entidade nova: quem dá
-- entrada informa lote/fabricação/validade, e o que está em estoque hoje sai
-- de uma conta (FEFO: o que vence antes sai antes) sobre o saldo do produto,
-- que continua sendo a soma das movimentações. Saída não precisa escolher
-- lote, o que mantém a operação de quem não liga para validade igual ao que
-- era. O estorno copia o lote da original, para descontar do lote certo.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS batch_code text,
  ADD COLUMN IF NOT EXISTS manufactured_on date,
  ADD COLUMN IF NOT EXISTS expires_on date;

-- Alvo das telas de validade: só as movimentações que carregam data.
CREATE INDEX IF NOT EXISTS stock_movements_validade_idx
  ON stock_movements (workspace_id, expires_on)
  WHERE expires_on IS NOT NULL;
