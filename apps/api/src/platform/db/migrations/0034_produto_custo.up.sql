-- Preço de custo por unidade. Nulo quer dizer "custo não informado": o
-- produto fica de fora das contas de lucro e de valor a custo, em vez de
-- entrar com custo zero (o que inflaria o lucro).
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_cost numeric(14, 4);
