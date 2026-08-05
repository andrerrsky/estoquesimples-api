package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONObject;

import java.util.UUID;

/**
 * Registro de movimentações de estoque.
 *
 * A regra central desta classe: alterar a quantidade de um produto e gravar a
 * movimentação correspondente é <b>uma única operação</b>. Antes, eram dois
 * comandos soltos — se o app fosse encerrado entre eles, o saldo mudava sem
 * deixar rastro, ou o histórico registrava algo que não aconteceu. Os dois
 * casos produzem um estoque que não bate com o histórico, e nenhum deles é
 * detectável depois.
 */
public final class MovementRepository {

    private static final String TAG = "MovementRepository";

    /** Tipos gravados no campo {@code change_type}. */
    public static final String ENTRADA = "entrada";
    public static final String SAIDA = "saida";
    public static final String AJUSTE = "ajuste";
    public static final String CADASTRO = "cadastro";
    public static final String IMPORTACAO = "importacao";
    public static final String EDICAO = "edicao";
    public static final String CANCELAMENTO = "cancelamento";

    /**
     * Tipos herdados. O app antigo gravava "venda" e "compra" além de
     * "entrada"/"saida", às vezes em maiúsculas — cada tela usou a sua
     * convenção. Nenhum deles é gerado hoje, mas todos existem no histórico dos
     * aparelhos e precisam somar corretamente. "compra" não precisa de menção
     * explícita: como entrada, cai no caso padrão.
     */
    private static final String VENDA = "venda";

    /**
     * Tipos que gravam {@code quantity} com sinal, porque representam uma
     * correção de saldo e podem ir nos dois sentidos. Nos demais tipos o
     * sentido já está no próprio nome, e a quantidade é sempre positiva.
     */
    private static boolean keepsSign(String changeType) {
        return AJUSTE.equalsIgnoreCase(changeType)
                || CANCELAMENTO.equalsIgnoreCase(changeType)
                || EDICAO.equalsIgnoreCase(changeType);
    }

    /**
     * Efeito real da movimentação sobre o saldo.
     *
     * Guardar entradas e saídas com sinal seria mais elegante em teoria, mas
     * todo o histórico já existente nos aparelhos usa valores positivos para
     * saídas. Passar a gravar negativo exigiria reescrever dados históricos do
     * usuário e mudar todas as telas que exibem a quantidade, para chegar ao
     * mesmo resultado que esta função entrega sem tocar em nada.
     */
    public static double signedQuantity(String changeType, double storedQuantity) {
        if (SAIDA.equalsIgnoreCase(changeType) || VENDA.equalsIgnoreCase(changeType)) {
            return -Math.abs(storedQuantity);
        }
        if (keepsSign(changeType)) {
            return storedQuantity;
        }
        return Math.abs(storedQuantity);
    }

    /**
     * Mesma regra da função acima, para uso dentro de SQL.
     *
     * A comparação passa por {@code LOWER} porque o histórico legado mistura
     * "SAIDA" e "saida"; sem isso, uma saída antiga entraria na soma como
     * entrada e o saldo calculado ficaria maior que o real.
     */
    public static final String SIGNED_QUANTITY_SQL =
            "CASE LOWER(change_type)"
                    + " WHEN '" + SAIDA + "' THEN -ABS(quantity)"
                    + " WHEN '" + VENDA + "' THEN -ABS(quantity)"
                    + " WHEN '" + AJUSTE + "' THEN quantity"
                    + " WHEN '" + CANCELAMENTO + "' THEN quantity"
                    + " WHEN '" + EDICAO + "' THEN quantity"
                    + " ELSE ABS(quantity) END";

    private final SQLiteDatabase db;

    public MovementRepository(SQLiteDatabase db) {
        this.db = db;
    }

    /** Resultado de uma tentativa de movimentação. */
    public static final class Result {
        public final boolean success;
        public final String message;
        public final double newAmount;
        public final String movementUuid;

        private Result(boolean success, String message, double newAmount, String movementUuid) {
            this.success = success;
            this.message = message;
            this.newAmount = newAmount;
            this.movementUuid = movementUuid;
        }

        static Result ok(double newAmount, String movementUuid) {
            return new Result(true, null, newAmount, movementUuid);
        }

        static Result fail(String message) {
            return new Result(false, message, 0d, null);
        }
    }

    /**
     * Aplica uma entrada ou saída de estoque.
     *
     * A quantidade atual é lida <b>dentro da transação</b>, e não recebida de
     * quem chamou. A tela antiga usava o valor que estava na lista da interface,
     * o que significa que duas saídas registradas em sequência rápida partiam
     * do mesmo saldo e uma sobrescrevia a outra. Lendo do banco, saídas
     * concorrentes somam, que é o comportamento que o usuário espera.
     *
     * @param delta positivo para entrada, negativo para saída.
     */
    public Result apply(String productUuid, String changeType, double delta, String note) {
        if (productUuid == null) {
            return Result.fail("Produto sem identificação.");
        }
        if (delta == 0d) {
            return Result.fail("Informe uma quantidade diferente de zero.");
        }

        db.beginTransaction();
        try {
            Snapshot atual = readForUpdate(productUuid);
            if (atual == null) {
                return Result.fail("Produto não encontrado.");
            }

            double newAmount = atual.amount + delta;
            if (newAmount < 0d) {
                return Result.fail("Quantidade insuficiente em estoque.");
            }

            long now = System.currentTimeMillis();

            // O saldo é atualizado sem mexer no `rev` do produto: quantidade
            // não é um campo editável que dois aparelhos disputam, é o
            // resultado das movimentações. Contá-la como edição faria uma
            // simples saída parecer conflito com quem mudou a descrição.
            ContentValues product = new ContentValues();
            product.put("amount", Quantities.forStorage(newAmount));
            product.put("updated_at", now);
            int rows = db.update(LocalDb.TABLE_PRODUCTS, product, "uuid=?",
                    new String[]{productUuid});
            if (rows == 0) {
                return Result.fail("Produto não encontrado.");
            }

            String movementUuid = insertMovement(productUuid, atual.name, changeType,
                    Math.abs(delta), note, now);
            if (movementUuid == null) {
                return Result.fail("Não foi possível registrar a movimentação.");
            }

            db.setTransactionSuccessful();
            return Result.ok(newAmount, movementUuid);
        } catch (Exception e) {
            Log.e(TAG, "falha ao registrar movimentação", e);
            return Result.fail("Erro ao registrar movimentação.");
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Define a quantidade para um valor absoluto, registrando a diferença como
     * ajuste. Usada na edição de produto e no ajuste em massa, onde o usuário
     * informa o saldo final e não a variação.
     */
    public Result setAbsolute(String productUuid, String changeType, double target, String note) {
        if (productUuid == null) {
            return Result.fail("Produto sem identificação.");
        }
        if (target < 0d) {
            return Result.fail("A quantidade não pode ser negativa.");
        }

        db.beginTransaction();
        try {
            Snapshot atual = readForUpdate(productUuid);
            if (atual == null) {
                return Result.fail("Produto não encontrado.");
            }

            double delta = target - atual.amount;
            long now = System.currentTimeMillis();

            ContentValues product = new ContentValues();
            product.put("amount", Quantities.forStorage(target));
            product.put("updated_at", now);
            db.update(LocalDb.TABLE_PRODUCTS, product, "uuid=?", new String[]{productUuid});

            String movementUuid = null;
            // Sem diferença de saldo não há evento: registrar um ajuste de zero
            // só encheria o histórico de ruído.
            if (delta != 0d) {
                movementUuid = insertMovement(productUuid, atual.name, changeType, delta, note, now);
                if (movementUuid == null) {
                    return Result.fail("Não foi possível registrar o ajuste.");
                }
            }

            db.setTransactionSuccessful();
            return Result.ok(target, movementUuid);
        } catch (Exception e) {
            Log.e(TAG, "falha ao ajustar quantidade", e);
            return Result.fail("Erro ao ajustar a quantidade.");
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Grava a movimentação de saldo inicial de um produto recém-criado.
     *
     * Deve ser chamada dentro da transação de cadastro. Sem este evento, a
     * soma do histórico nunca reproduz o saldo do produto, e o histórico deixa
     * de ser uma explicação completa de como o estoque chegou onde está.
     *
     * @param productName nome vindo de quem cadastrou. Recebê-lo pronto evita
     *                    uma consulta por registro durante a importação de um
     *                    CSV, onde o cadastro acontece milhares de vezes
     *                    seguidas e quem chama já tem o nome em mãos.
     */
    public String recordInitialBalance(String productUuid, String productName, double amount,
                                       String changeType) {
        if (productUuid == null || amount == 0d) {
            return null;
        }
        return insertMovement(productUuid, productName, changeType, amount, null,
                System.currentTimeMillis());
    }

    /**
     * Cancela uma movimentação gravando o evento oposto.
     *
     * A movimentação original permanece no histórico. Apagá-la faria o saldo
     * atual deixar de ser explicável pelos eventos registrados, que é
     * exatamente a propriedade que torna um histórico confiável.
     *
     * <p>Ela é marcada com {@code cancelled_at}, e é essa marca que impede o
     * segundo cancelamento. Sem ela, nada distinguia uma movimentação já
     * desfeita de uma intacta, e cada toque repetido — dois cliques, a tela
     * recarregada, o mesmo item aberto de novo — inseria mais um estorno e
     * somava mais uma vez ao estoque. A marca não entra na soma do saldo: o
     * evento original e o estorno se anulam, e é assim que precisa continuar.
     */
    public Result cancel(String movementUuid, String note) {
        Cursor cursor = null;
        db.beginTransaction();
        try {
            cursor = db.rawQuery(
                    "SELECT product_uuid, change_type, quantity, cancelled_at FROM "
                            + LocalDb.TABLE_MOVEMENTS
                            + " WHERE uuid=? AND deleted_at IS NULL",
                    new String[]{movementUuid});
            if (!cursor.moveToFirst()) {
                return Result.fail("Movimentação não encontrada.");
            }
            if (!cursor.isNull(3)) {
                return Result.fail("Esta movimentação já foi cancelada.");
            }

            String productUuid = cursor.getString(0);
            String originalType = cursor.getString(1);
            double quantity = cursor.getDouble(2);
            if (productUuid == null) {
                return Result.fail("Movimentação sem produto vinculado.");
            }

            Snapshot atual = readForUpdate(productUuid);
            if (atual == null) {
                return Result.fail("Produto não encontrado.");
            }

            // O evento compensatório é o inverso do efeito real da original,
            // que depende do tipo: cancelar uma saída devolve ao estoque.
            double compensation = -signedQuantity(originalType, quantity);
            double newAmount = atual.amount + compensation;
            if (newAmount < 0d) {
                return Result.fail("O cancelamento deixaria o estoque negativo.");
            }

            long now = System.currentTimeMillis();

            // A marca vem antes do estorno e é condicionada de novo a
            // cancelled_at nulo: duas tentativas simultâneas disputam esta
            // linha, e só uma delas vai encontrar a coluna ainda vazia.
            ContentValues marca = new ContentValues();
            marca.put("cancelled_at", now);
            int marcadas = db.update(LocalDb.TABLE_MOVEMENTS, marca,
                    "uuid=? AND cancelled_at IS NULL", new String[]{movementUuid});
            if (marcadas == 0) {
                return Result.fail("Esta movimentação já foi cancelada.");
            }

            ContentValues product = new ContentValues();
            product.put("amount", Quantities.forStorage(newAmount));
            product.put("updated_at", now);
            db.update(LocalDb.TABLE_PRODUCTS, product, "uuid=?", new String[]{productUuid});

            String compensationUuid = insertMovement(
                    productUuid, atual.name, CANCELAMENTO, compensation, note, now);
            if (compensationUuid == null) {
                return Result.fail("Não foi possível registrar o cancelamento.");
            }

            db.setTransactionSuccessful();
            return Result.ok(newAmount, compensationUuid);
        } catch (Exception e) {
            Log.e(TAG, "falha ao cancelar movimentação", e);
            return Result.fail("Erro ao cancelar a movimentação.");
        } finally {
            LocalDb.closeQuietly(cursor);
            db.endTransaction();
        }
    }

    /**
     * Soma de todas as movimentações de um produto. Usada no diagnóstico para
     * confirmar que o saldo armazenado é reproduzível a partir dos eventos.
     */
    public double sumMovements(String productUuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT COALESCE(SUM(" + SIGNED_QUANTITY_SQL + "), 0) FROM "
                            + LocalDb.TABLE_MOVEMENTS
                            + " WHERE product_uuid=? AND deleted_at IS NULL",
                    new String[]{productUuid});
            return cursor.moveToFirst() ? cursor.getDouble(0) : 0d;
        } catch (Exception e) {
            Log.e(TAG, "falha ao somar movimentações", e);
            return 0d;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /** Saldo e nome do produto lidos numa consulta só, dentro da transação. */
    private static final class Snapshot {
        final double amount;
        final String name;

        Snapshot(double amount, String name) {
            this.amount = amount;
            this.name = name;
        }
    }

    private Snapshot readForUpdate(String productUuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT amount, name FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=?",
                    new String[]{productUuid});
            if (!cursor.moveToFirst()) {
                return null;
            }
            return new Snapshot(Quantities.parse(cursor.getString(0)), cursor.getString(1));
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Insere o evento.
     *
     * O {@code product_name} continua sendo preenchido porque as telas de
     * histórico e os relatórios ainda o exibem, mas ele passa a ser um retrato
     * do nome no momento do evento, não a forma de identificar o produto — esse
     * papel agora é do {@code product_uuid}. Ele chega pronto de quem chama:
     * todos já leram a linha do produto para conferir o saldo, e buscá-lo de
     * novo aqui era uma consulta por movimentação.
     */
    private String insertMovement(String productUuid, String productName, String changeType,
                                  double quantity, String note, long timestamp) {
        String movementUuid = UUID.randomUUID().toString();

        double stored = keepsSign(changeType) ? quantity : Math.abs(quantity);

        ContentValues values = new ContentValues();
        values.put("uuid", movementUuid);
        values.put("product_uuid", productUuid);
        values.put("product_name", productName);
        values.put("change_type", changeType);
        values.put("quantity", stored);
        values.put("timestamp", timestamp);
        values.put("updated_at", timestamp);
        values.put("rev", 0);
        if (note != null && !note.trim().isEmpty()) {
            values.put("note", note.trim());
        }

        if (db.insert(LocalDb.TABLE_MOVEMENTS, null, values) < 0) {
            Log.e(TAG, "falha ao gravar a movimentação");
            return null;
        }

        if (SyncGate.shouldEnqueue()) {
            JSONObject payload = SyncPayloads.movement(db, movementUuid);
            // Movimentações nunca são compactadas nem reescritas: cada uma é um
            // fato que aconteceu. Se a operação não puder ser enfileirada, a
            // transação inteira precisa cair, senão o evento existiria só aqui.
            if (payload == null || new OutboxRepository(db).enqueue(
                    OutboxRepository.ENTITY_MOVIMENTACAO, movementUuid,
                    OutboxRepository.OP_MOVEMENT, null, payload.toString()) == null) {
                return null;
            }
        }
        return movementUuid;
    }
}
