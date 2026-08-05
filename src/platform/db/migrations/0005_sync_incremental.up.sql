-- Fase 7: sincronização incremental.

-- ---------------------------------------------------------------------------
-- Horizonte das lápides
--
-- Um aparelho que ficou meses desligado volta com um cursor antigo e pede tudo
-- o que mudou desde então. Isso funciona porque exclusões viram lápides e
-- continuam na tabela. Se algum dia essas lápides forem removidas para liberar
-- espaço, os cursores anteriores à limpeza passam a mentir: o aparelho
-- receberia as alterações posteriores sem nunca saber das exclusões, e ficaria
-- com produtos que não existem mais — sem erro nenhum aparecendo.
--
-- Esta coluna registra até onde a limpeza chegou. Cursor abaixo dela recebe
-- SYNC_RESYNC_REQUIRED e refaz a carga, que é lento mas correto.
-- ---------------------------------------------------------------------------

ALTER TABLE workspaces
  ADD COLUMN tombstone_horizon_seq bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Posição de cada aparelho
--
-- O cursor de verdade é o que o aparelho guarda; esta tabela é a cópia que o
-- servidor enxerga. Ela serve para duas coisas concretas: mostrar ao usuário
-- quais aparelhos estão atrasados, e definir até onde a limpeza de lápides
-- pode avançar sem quebrar quem ainda não leu.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_cursors (
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  device_id    uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  user_id      uuid        REFERENCES users (id) ON DELETE SET NULL,
  cursor       bigint      NOT NULL DEFAULT 0,
  last_push_at timestamptz,
  last_pull_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, device_id)
);

CREATE INDEX sync_cursors_atraso_idx ON sync_cursors (workspace_id, cursor);

ALTER TABLE sync_cursors ENABLE ROW LEVEL SECURITY;

CREATE POLICY sync_cursors_tenant ON sync_cursors
  USING (workspace_id = app_current_workspace())
  WITH CHECK (workspace_id = app_current_workspace());

GRANT SELECT, INSERT, UPDATE, DELETE ON sync_cursors TO app_user;

-- ---------------------------------------------------------------------------
-- Saldo derivado do histórico
--
-- O saldo é a soma dos movimentos, mas somar o histórico inteiro a cada
-- listagem não escala, então `quantity_cache` guarda o resultado. Atualizar os
-- dois na mesma transação é o que impede a projeção de derivar da verdade.
--
-- Fica no banco, e não na aplicação, porque o movimento chega por caminhos
-- diferentes e um deles esquecer de atualizar o saldo é questão de tempo.
--
-- A carga inicial é a exceção e desliga o gatilho: lá o saldo vem pronto do
-- aparelho, porque o histórico legado é incompleto. O app só passou a registrar
-- movimentação para toda alteração agora; somar o histórico antigo daria um
-- número menor que o estoque que o usuário vê na tela.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_movement_to_balance() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.carga_inicial', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    UPDATE products
       SET quantity_cache = quantity_cache + NEW.quantity
     WHERE id = NEW.product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_atualiza_saldo
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_balance();
