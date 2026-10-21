package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Leva para a nuvem o que foi cadastrado neste aparelho antes do primeiro
 * login, quando a empresa já tem dados lá.
 *
 * <p>Antes, o aparelho adotava a nuvem e descartava tudo o que era só dele: a
 * pessoa cadastrava um produto, entrava na conta, sincronizava e o produto
 * sumia (ficava apenas na cópia de segurança). Agora cada produto que a nuvem
 * não conhece vai para a fila de saída como um cadastro, junto com o histórico
 * dele, e sobe na mesma rodada.
 *
 * <p>Os identificadores foram gerados aqui, então enviar não duplica nada por
 * id. O que pode duplicar é a mesma mercadoria cadastrada nos dois lugares; por
 * isso um produto com o mesmo código de barras ou o mesmo nome de um que já
 * está na nuvem fica de fora (a versão da nuvem prevalece e a do aparelho
 * continua na cópia de segurança).
 *
 * <p>Só vale para um aparelho que nunca sincronizou com nenhuma empresa: o
 * banco de um aparelho que já usou outra empresa tem dados dela, que não podem
 * ir parar nesta.
 */
public final class LocalMerge {

    private static final String TAG = "LocalMerge";

    private LocalMerge() {
    }

    public static final class Result {
        public final int enviados;
        public final int repetidos;

        public Result(int enviados, int repetidos) {
            this.enviados = enviados;
            this.repetidos = repetidos;
        }
    }

    /**
     * Enfileira os produtos locais ausentes da nuvem e o histórico deles.
     *
     * Deve rodar depois de a leitura completa da nuvem ter sido gravada (para
     * comparar nomes e códigos) e antes de {@link RemoteChanges#removeAusentes()},
     * que preserva o que estiver na fila.
     *
     * @param vistosNaNuvem uuids de produtos que vieram da nuvem nesta leitura.
     */
    public static Result enqueueLocalOnly(SQLiteDatabase db, Set<String> vistosNaNuvem) {
        Set<String> nomesNaNuvem = new HashSet<>();
        Set<String> codigosNaNuvem = new HashSet<>();
        List<String[]> locais = new ArrayList<>();

        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT uuid, name, barcode FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE uuid IS NOT NULL AND deleted_at IS NULL", null);
            while (cursor.moveToNext()) {
                String uuid = cursor.getString(0);
                String nome = normalize(cursor.getString(1));
                String codigo = normalize(cursor.getString(2));
                if (vistosNaNuvem.contains(uuid)) {
                    if (!nome.isEmpty()) nomesNaNuvem.add(nome);
                    if (!codigo.isEmpty()) codigosNaNuvem.add(codigo);
                } else {
                    locais.add(new String[]{uuid, nome, codigo});
                }
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }

        if (locais.isEmpty()) {
            return new Result(0, 0);
        }

        OutboxRepository outbox = new OutboxRepository(db);
        int enviados = 0;
        int repetidos = 0;
        db.beginTransaction();
        try {
            for (String[] local : locais) {
                String uuid = local[0];
                boolean repetido = (!local[2].isEmpty() && codigosNaNuvem.contains(local[2]))
                        || (!local[1].isEmpty() && nomesNaNuvem.contains(local[1]));
                if (repetido) {
                    repetidos++;
                    continue;
                }
                if (outbox.hasPending(uuid)) {
                    continue; // já está a caminho
                }
                JSONObject produto = SyncPayloads.product(db, uuid);
                if (produto == null || outbox.enqueue(OutboxRepository.ENTITY_PRODUTO, uuid,
                        OutboxRepository.OP_UPSERT, null, produto.toString()) == null) {
                    throw new IllegalStateException("não foi possível enfileirar o produto");
                }
                enqueueHistory(db, outbox, uuid);
                // Mesmos nomes dentro do próprio aparelho não são repetição da nuvem.
                enviados++;
            }
            db.setTransactionSuccessful();
        } catch (RuntimeException e) {
            Log.e(TAG, "falha ao preparar o envio dos produtos do aparelho", e);
            return new Result(0, repetidos);
        } finally {
            db.endTransaction();
        }
        Log.i(TAG, enviados + " produto(s) do aparelho a enviar, " + repetidos + " repetido(s)");
        return new Result(enviados, repetidos);
    }

    /**
     * Histórico do produto, em ordem, e um ajuste final se a soma dele não
     * explicar o saldo (bancos antigos não registravam o saldo inicial).
     *
     * Na nuvem o saldo é sempre a soma das movimentações: um produto que
     * subisse só com a quantidade apareceria lá zerado.
     */
    private static void enqueueHistory(SQLiteDatabase db, OutboxRepository outbox, String productUuid) {
        double soma = 0d;
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT uuid, " + MovementRepository.SIGNED_QUANTITY_SQL
                    + " FROM " + LocalDb.TABLE_MOVEMENTS
                    + " WHERE product_uuid=? AND uuid IS NOT NULL AND deleted_at IS NULL"
                    + " ORDER BY timestamp, id", new String[]{productUuid});
            while (cursor.moveToNext()) {
                String movementUuid = cursor.getString(0);
                soma += cursor.getDouble(1);
                enqueueMovement(db, outbox, movementUuid);
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }

        double saldo = 0d;
        String nome = null;
        Cursor produto = null;
        try {
            produto = db.rawQuery("SELECT amount, name FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE uuid=?", new String[]{productUuid});
            if (produto.moveToFirst()) {
                saldo = Quantities.parse(produto.getString(0));
                nome = produto.getString(1);
            }
        } finally {
            LocalDb.closeQuietly(produto);
        }

        double diferenca = Math.round((saldo - soma) * 10_000d) / 10_000d;
        if (diferenca == 0d) {
            return;
        }
        String uuid = UUID.randomUUID().toString();
        long agora = System.currentTimeMillis();
        ContentValues values = new ContentValues();
        values.put("uuid", uuid);
        values.put("product_uuid", productUuid);
        values.put("product_name", nome);
        // Sem histórico nenhum, o saldo é o do cadastro; senão, um ajuste com sinal.
        boolean cadastro = soma == 0d && diferenca > 0d;
        values.put("change_type", cadastro ? MovementRepository.CADASTRO : MovementRepository.AJUSTE);
        values.put("quantity", diferenca);
        values.put("timestamp", agora);
        values.put("updated_at", agora);
        values.put("rev", 0);
        values.put("note", "Saldo do aparelho ao entrar na conta");
        if (db.insert(LocalDb.TABLE_MOVEMENTS, null, values) < 0) {
            throw new IllegalStateException("não foi possível registrar o saldo do aparelho");
        }
        enqueueMovement(db, outbox, uuid);
    }

    private static void enqueueMovement(SQLiteDatabase db, OutboxRepository outbox, String movementUuid) {
        if (outbox.hasPending(movementUuid)) {
            return;
        }
        JSONObject payload = SyncPayloads.movement(db, movementUuid);
        if (payload == null || outbox.enqueue(OutboxRepository.ENTITY_MOVIMENTACAO, movementUuid,
                OutboxRepository.OP_MOVEMENT, null, payload.toString()) == null) {
            throw new IllegalStateException("não foi possível enfileirar a movimentação");
        }
    }

    /** Minúsculas, sem acento e sem espaços repetidos: "Açúcar  1kg" = "acucar 1kg". */
    static String normalize(String value) {
        if (value == null) {
            return "";
        }
        String semAcento = Normalizer.normalize(value, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        return semAcento.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }
}
