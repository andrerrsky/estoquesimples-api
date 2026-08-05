package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;

/**
 * Fila das alterações locais que ainda precisam chegar ao servidor.
 *
 * A operação é gravada na <b>mesma transação</b> da alteração que a originou.
 * Essa é a única forma de garantir que as duas coisas concordem: se a
 * movimentação existe no banco, a operação de envio também existe, e vice-versa.
 * Gravar depois, fora da transação, cria a janela em que o app é encerrado
 * entre as duas e a alteração some do servidor para sempre — sem nenhum sinal
 * de que isso aconteceu.
 */
public final class OutboxRepository {

    private static final String TAG = "OutboxRepository";

    public static final String ENTITY_PRODUTO = "produto";
    public static final String ENTITY_MOVIMENTACAO = "movimentacao";

    public static final String OP_UPSERT = "upsert";
    public static final String OP_DELETE = "delete";
    public static final String OP_MOVEMENT = "movement";

    public static final String STATUS_PENDENTE = "pendente";
    /** Falha que não adianta repetir; fica visível ao usuário, nunca sumindo. */
    public static final String STATUS_FALHA = "falha_permanente";

    /** Teto do backoff. Acima disso, tentar mais rápido só gasta bateria. */
    private static final long BACKOFF_MAXIMO_MS = 15 * 60 * 1000L;

    /** Tentativas assumidas quando não foi possível ler o contador real. */
    private static final int TENTATIVAS_NA_DUVIDA = 5;

    private final SQLiteDatabase db;

    public OutboxRepository(SQLiteDatabase db) {
        this.db = db;
    }

    /** Operação pendente, como será enviada. */
    public static final class Operation {
        public final long id;
        public final String opId;
        public final String entityType;
        public final String entityId;
        public final String op;
        public final Long baseRev;
        public final String payload;
        public final int attempts;
        public final String lastError;

        Operation(long id, String opId, String entityType, String entityId, String op,
                  Long baseRev, String payload, int attempts, String lastError) {
            this.id = id;
            this.opId = opId;
            this.entityType = entityType;
            this.entityId = entityId;
            this.op = op;
            this.baseRev = baseRev;
            this.payload = payload;
            this.attempts = attempts;
            this.lastError = lastError;
        }
    }

    // -------------------------------------------------------------------------
    // Escrita
    // -------------------------------------------------------------------------

    /**
     * Enfileira uma operação. Deve ser chamada dentro da transação que fez a
     * alteração correspondente.
     *
     * @return o {@code op_id} gerado, ou {@code null} se não foi possível
     *         enfileirar — caso em que quem chamou deve desfazer a transação,
     *         porque salvar a alteração sem a operação faria o aparelho e o
     *         servidor divergirem silenciosamente.
     */
    public String enqueue(String entityType, String entityId, String op,
                          Long baseRev, String payload) {
        String opId = UUID.randomUUID().toString();

        ContentValues values = new ContentValues();
        values.put("op_id", opId);
        values.put("entity_type", entityType);
        values.put("entity_id", entityId);
        values.put("op", op);
        if (baseRev != null) {
            values.put("base_rev", baseRev);
        }
        values.put("payload", payload);
        values.put("created_at", System.currentTimeMillis());
        values.put("next_attempt_at", 0L);
        values.put("status", STATUS_PENDENTE);

        long id = db.insert(LocalDb.TABLE_OUTBOX, null, values);
        if (id < 0) {
            Log.e(TAG, "falha ao enfileirar operação " + op + " de " + entityType);
            return null;
        }
        return opId;
    }

    /** Remove as operações confirmadas pelo servidor. */
    public void markSent(List<String> opIds) {
        if (opIds == null || opIds.isEmpty()) {
            return;
        }
        db.beginTransaction();
        try {
            for (String opId : opIds) {
                db.delete(LocalDb.TABLE_OUTBOX, "op_id=?", new String[]{opId});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Reagenda uma operação que falhou por motivo transitório.
     *
     * O intervalo dobra a cada tentativa com um componente aleatório. O sorteio
     * não é enfeite: sem ele, todos os aparelhos que perderam conexão ao mesmo
     * tempo voltam ao mesmo tempo, e o servidor recebe de uma vez a carga que
     * deveria estar distribuída.
     */
    public void markTransientFailure(String opId, String error) {
        int attempts = attemptsOf(opId) + 1;
        long base = Math.min(BACKOFF_MAXIMO_MS, 1000L * (1L << Math.min(attempts, 20)));
        long jitter = (long) (base * 0.2 * Math.random());

        ContentValues values = new ContentValues();
        values.put("attempts", attempts);
        values.put("next_attempt_at", System.currentTimeMillis() + base + jitter);
        values.put("last_error", error);
        db.update(LocalDb.TABLE_OUTBOX, values, "op_id=?", new String[]{opId});
    }

    /**
     * Marca uma operação que o servidor recusou de forma definitiva.
     *
     * Ela sai da fila de envio mas <b>não</b> é apagada: o usuário precisa
     * poder ver o que não subiu e exportar, em vez de descobrir semanas depois
     * que faltam registros na nuvem.
     */
    public void markPermanentFailure(String opId, String error) {
        ContentValues values = new ContentValues();
        values.put("status", STATUS_FALHA);
        values.put("last_error", error);
        db.update(LocalDb.TABLE_OUTBOX, values, "op_id=?", new String[]{opId});
    }

    /**
     * Descarta a fila inteira. Usada no logout e depois de uma recarga completa,
     * quando as operações pendentes já não fazem sentido.
     */
    public void clear() {
        db.delete(LocalDb.TABLE_OUTBOX, null, null);
    }

    /**
     * Reduz edições repetidas do mesmo produto a uma só.
     *
     * Quem corrige o preço cinco vezes seguidas sem rede gera cinco operações
     * que descrevem o mesmo registro; só a última tem algum efeito. Sem isso, um
     * aparelho que passou o fim de semana offline volta enviando centenas de
     * versões intermediárias de meia dúzia de produtos.
     *
     * Movimentações nunca são compactadas: cada uma é um fato distinto, e
     * juntar duas saídas numa só apagaria estoque que saiu de verdade.
     *
     * @return quantas operações foram descartadas.
     */
    /** Um grupo de operações da mesma entidade, pronto para ser compactado. */
    private static final class Grupo {
        final String entityId;
        final long sobrevivente;
        final long menorBase;

        Grupo(String entityId, long sobrevivente, long menorBase) {
            this.entityId = entityId;
            this.sobrevivente = sobrevivente;
            this.menorBase = menorBase;
        }
    }

    public int compact() {
        int descartadas = 0;
        db.beginTransaction();
        try {
            List<Grupo> grupos = gruposCompactaveis();

            for (Grupo grupo : grupos) {
                JSONObject payload = mergePayloads(grupo.entityId, grupo.sobrevivente);

                descartadas += db.delete(LocalDb.TABLE_OUTBOX,
                        "status=? AND entity_type=? AND op=? AND entity_id=? AND id<>?",
                        new String[]{STATUS_PENDENTE, ENTITY_PRODUTO, OP_UPSERT, grupo.entityId,
                                String.valueOf(grupo.sobrevivente)});

                ContentValues values = new ContentValues();
                if (grupo.menorBase < 0) {
                    // Havia um cadastro no meio: para a nuvem, o registro ainda
                    // não existe e não há versão de origem a comparar.
                    values.putNull("base_rev");
                } else {
                    values.put("base_rev", grupo.menorBase);
                }
                if (payload != null) {
                    values.put("payload", payload.toString());
                }
                db.update(LocalDb.TABLE_OUTBOX, values, "id=?",
                        new String[]{String.valueOf(grupo.sobrevivente)});
            }

            db.setTransactionSuccessful();
        } catch (Exception e) {
            Log.e(TAG, "falha ao compactar a fila de saída", e);
        } finally {
            db.endTransaction();
        }
        return descartadas;
    }

    /**
     * Lê os grupos primeiro, para só depois mexer na tabela.
     *
     * A versão anterior apagava e atualizava linhas enquanto percorria o cursor
     * do próprio {@code GROUP BY}. O cursor do Android carrega os resultados em
     * janelas e reexecuta a consulta quando precisa da janela seguinte: como as
     * primeiras linhas já tinham sido compactadas, o agrupamento voltava
     * diferente e entidades inteiras eram puladas — ficavam na fila com as
     * versões intermediárias que a compactação existia para eliminar.
     *
     * <p>A versão de origem que sobrevive é a mais antiga do grupo: a sequência
     * de edições, vista de fora, partiu dali. Manter a última faria o servidor
     * comparar com uma versão que ele nunca chegou a conhecer e acusar conflito
     * onde não há.
     */
    private List<Grupo> gruposCompactaveis() {
        List<Grupo> grupos = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT entity_id, MAX(id), MIN(COALESCE(base_rev, -1)) "
                            + "FROM " + LocalDb.TABLE_OUTBOX
                            + " WHERE status=? AND entity_type=? AND op=? "
                            + "GROUP BY entity_id HAVING COUNT(*) > 1",
                    new String[]{STATUS_PENDENTE, ENTITY_PRODUTO, OP_UPSERT});
            while (cursor.moveToNext()) {
                grupos.add(new Grupo(cursor.getString(0), cursor.getLong(1), cursor.getLong(2)));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar os grupos da fila de saída", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return grupos;
    }

    /**
     * Junta o estado atual do produto com o ponto de partida mais antigo.
     *
     * Quem editou o preço, depois a categoria e depois o fornecedor produziu
     * três operações. A última carrega o registro completo e é a que fica —
     * mas o "antes" dela é o preço já corrigido, não o original. Enviar assim
     * faria o servidor concluir que só o fornecedor mudou, e uma alteração de
     * preço feita em outro aparelho no meio-tempo apagaria a daqui em silêncio.
     */
    private JSONObject mergePayloads(String entityId, long sobrevivente) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT id, payload FROM " + LocalDb.TABLE_OUTBOX
                            + " WHERE status=? AND entity_type=? AND op=? AND entity_id=? "
                            + "ORDER BY id",
                    new String[]{STATUS_PENDENTE, ENTITY_PRODUTO, OP_UPSERT, entityId});

            JSONObject anteriorAcumulado = new JSONObject();
            JSONObject ultimo = null;

            while (cursor.moveToNext()) {
                JSONObject payload = new JSONObject(cursor.getString(1));
                JSONObject anterior = payload.optJSONObject("previous");
                if (anterior != null) {
                    Iterator<String> campos = anterior.keys();
                    while (campos.hasNext()) {
                        String campo = campos.next();
                        // O primeiro valor visto para cada campo é o verdadeiro
                        // ponto de partida; os seguintes já são consequência
                        // das edições anteriores desta mesma fila.
                        if (!anteriorAcumulado.has(campo)) {
                            anteriorAcumulado.put(campo, anterior.get(campo));
                        }
                    }
                }
                if (cursor.getLong(0) == sobrevivente) {
                    ultimo = payload;
                }
            }

            if (ultimo == null) {
                return null;
            }
            if (anteriorAcumulado.length() > 0) {
                ultimo.put("previous", anteriorAcumulado);
            }
            return ultimo;

        } catch (Exception e) {
            Log.e(TAG, "falha ao juntar operações do produto " + entityId, e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Indica se a entidade tem alteração local ainda não confirmada.
     *
     * Usado ao aplicar o que vem da nuvem: sobrescrever um registro que ainda
     * tem edição na fila apagaria da tela algo que o usuário acabou de digitar
     * e que ainda vai subir.
     *
     * <p>O filtro é por {@code (entity_id, status)} e a versão 5 do schema
     * criou o índice com essa ordem. O índice antigo começava por
     * {@code entity_type}, que não aparece aqui, então o SQLite não conseguia
     * usá-lo: cada registro recebido custava uma varredura da fila inteira.
     */
    public boolean hasPending(String entityId) {
        return countWhere("entity_id=? AND status=?", entityId, STATUS_PENDENTE) > 0;
    }

    // -------------------------------------------------------------------------
    // Leitura
    // -------------------------------------------------------------------------

    /** Próximo lote pronto para envio, na ordem em que foi gerado. */
    public List<Operation> nextBatch(int limit) {
        List<Operation> batch = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT id, op_id, entity_type, entity_id, op, base_rev, payload, attempts, "
                            + "last_error FROM " + LocalDb.TABLE_OUTBOX
                            + " WHERE status=? AND next_attempt_at <= ? "
                            + "ORDER BY id LIMIT " + limit,
                    new String[]{STATUS_PENDENTE, String.valueOf(System.currentTimeMillis())});
            while (cursor.moveToNext()) {
                batch.add(new Operation(
                        cursor.getLong(0),
                        cursor.getString(1),
                        cursor.getString(2),
                        cursor.getString(3),
                        cursor.getString(4),
                        cursor.isNull(5) ? null : cursor.getLong(5),
                        cursor.getString(6),
                        cursor.getInt(7),
                        cursor.getString(8)));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler a fila de saída", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return batch;
    }

    public int pendingCount() {
        return countWhere("status=?", STATUS_PENDENTE);
    }

    public int failedCount() {
        return countWhere("status=?", STATUS_FALHA);
    }

    /** Operações que falharam de forma definitiva, para exibição e exportação. */
    public List<Operation> failures() {
        List<Operation> failures = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT id, op_id, entity_type, entity_id, op, base_rev, payload, attempts, "
                            + "last_error FROM " + LocalDb.TABLE_OUTBOX
                            + " WHERE status=? ORDER BY id",
                    new String[]{STATUS_FALHA});
            while (cursor.moveToNext()) {
                failures.add(new Operation(
                        cursor.getLong(0), cursor.getString(1), cursor.getString(2),
                        cursor.getString(3), cursor.getString(4),
                        cursor.isNull(5) ? null : cursor.getLong(5),
                        cursor.getString(6), cursor.getInt(7), cursor.getString(8)));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar operações com erro", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return failures;
    }

    /**
     * Quantas vezes esta operação já falhou.
     *
     * Numa falha de leitura devolve {@link #TENTATIVAS_NA_DUVIDA}, não zero.
     * Zero significaria "primeira tentativa" e reiniciaria o intervalo no
     * mínimo — justo quando o banco está com problema, o aparelho voltaria a
     * bater no servidor de segundo em segundo. Sem saber, é melhor errar para o
     * lado de esperar mais.
     */
    private int attemptsOf(String opId) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT attempts FROM " + LocalDb.TABLE_OUTBOX + " WHERE op_id=?",
                    new String[]{opId});
            return cursor.moveToFirst() ? cursor.getInt(0) : TENTATIVAS_NA_DUVIDA;
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler o número de tentativas de " + opId, e);
            return TENTATIVAS_NA_DUVIDA;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private int countWhere(String where, String... args) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT COUNT(*) FROM " + LocalDb.TABLE_OUTBOX + " WHERE " + where, args);
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao contar a fila de saída", e);
            return 0;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }
}
