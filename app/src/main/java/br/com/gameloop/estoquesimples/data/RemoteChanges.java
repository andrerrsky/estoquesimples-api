package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Aplica no banco local as alterações vindas da nuvem.
 *
 * Duas regras governam tudo aqui e valem a pena antes do código:
 *
 * <p>A primeira é que aplicar duas vezes precisa dar no mesmo. A conexão vai
 * cair no meio de uma página e o app vai pedir aquele trecho de novo; se
 * reaplicar somasse de novo, o estoque cresceria a cada queda de sinal.
 *
 * <p>A segunda é que alteração local pendente tem precedência. O que ainda está
 * na fila de saída representa algo que o usuário digitou e que a nuvem nem viu.
 * Sobrescrever esse registro com a versão de lá apagaria da tela um trabalho que
 * ainda estava a caminho.
 */
public final class RemoteChanges {

    private static final String TAG = "RemoteChanges";

    /** {@link #apply} devolve isto quando nada foi gravado por causa de um erro. */
    public static final int FALHOU = -1;

    private final SQLiteDatabase db;
    private final OutboxRepository outbox;

    /** Identificadores vistos na passada, usados na recarga completa. */
    private final Set<String> produtosVistos = new HashSet<>();
    private final Set<String> movimentacoesVistas = new HashSet<>();

    /** Quantas alterações o servidor entregou, somando todas as páginas. */
    private int recebidasNoTotal;

    /**
     * Uma alteração precisou ficar para depois porque a entidade tem edição
     * local na fila. O cursor parou antes dela.
     */
    private boolean adiadoPorPendencia;

    public RemoteChanges(SQLiteDatabase db) {
        this.db = db;
        this.outbox = new OutboxRepository(db);
    }

    public Set<String> produtosVistos() {
        return produtosVistos;
    }

    public Set<String> movimentacoesVistas() {
        return movimentacoesVistas;
    }

    /**
     * A leitura precisa parar aqui: o cursor não passou da alteração adiada e
     * seguir adiante gravaria um cursor à frente dela.
     */
    public boolean adiadoPorPendencia() {
        return adiadoPorPendencia;
    }

    public int recebidasNoTotal() {
        return recebidasNoTotal;
    }

    /** O que cada alteração recebida produziu. */
    private enum Efeito {
        /** Gravada. */
        APLICADA,
        /** Reconhecida e sem efeito — já estava assim. */
        IGNORADA,
        /** Não pode ser gravada agora; o cursor tem de esperar por ela. */
        ADIADA
    }

    /**
     * Aplica uma página inteira e avança o cursor na mesma transação.
     *
     * O cursor precisa avançar junto com os dados. Guardado depois, uma queda
     * entre as duas gravações faria o app reprocessar a página; guardado antes,
     * faria pular. Só dentro da transação as duas coisas são inseparáveis.
     *
     * <p>Duas situações interrompem o avanço do cursor. A primeira é uma
     * alteração adiada: se o produto tem edição local esperando na fila, a
     * versão do servidor não pode ser gravada por cima, e o cursor precisa
     * parar <b>antes</b> dela para que o servidor a entregue de novo quando a
     * fila esvaziar. Passar por cima descartava aquela versão para sempre. A
     * segunda é uma falha: a página volta atrás inteira e o retorno é
     * {@link #FALHOU}, para que quem chama interrompa a leitura em vez de
     * seguir para a página seguinte — que gravaria um cursor mais adiantado e
     * enterraria a página com problema.
     *
     * @return quantas alterações foram aplicadas, ou {@link #FALHOU}.
     */
    public int apply(JSONArray changes, String cursor) {
        int aplicadas = 0;
        boolean adiou = false;

        db.beginTransaction();
        try {
            for (int i = 0; i < changes.length(); i++) {
                JSONObject change = changes.optJSONObject(i);
                if (change == null) {
                    continue;
                }
                Efeito efeito = applyOne(change);
                if (efeito == Efeito.ADIADA) {
                    adiou = true;
                    break;
                }
                if (efeito == Efeito.APLICADA) {
                    aplicadas++;
                }
            }

            // O que foi aplicado antes da alteração adiada fica gravado: tudo
            // aqui é idempotente, então recebê-lo de novo não faz diferença.
            if (!adiou) {
                new SyncMeta(db).put(SyncMeta.CURSOR, cursor);
            }
            db.setTransactionSuccessful();
        } catch (Exception e) {
            Log.e(TAG, "falha ao aplicar alterações recebidas", e);
            return FALHOU;
        } finally {
            db.endTransaction();
        }

        adiadoPorPendencia = adiou;
        recebidasNoTotal += changes.length();
        return aplicadas;
    }

    private Efeito applyOne(JSONObject change) {
        JSONObject data = change.optJSONObject("data");
        if (data == null) {
            return Efeito.IGNORADA;
        }
        String entity = change.optString("entity");

        if (OutboxRepository.ENTITY_PRODUTO.equals(entity)) {
            return applyProduct(data, change.optBoolean("deleted", false));
        }
        if (OutboxRepository.ENTITY_MOVIMENTACAO.equals(entity)) {
            return applyMovement(data);
        }
        return Efeito.IGNORADA;
    }

    private Efeito applyProduct(JSONObject data, boolean excluido) {
        String uuid = data.optString("id", null);
        if (uuid == null) {
            return Efeito.IGNORADA;
        }
        produtosVistos.add(uuid);

        if (outbox.hasPending(uuid)) {
            return Efeito.ADIADA;
        }

        ContentValues values = new ContentValues();
        values.put("uuid", uuid);
        values.put("name", data.optString("name", ""));
        values.put("description", optString(data, "description"));
        values.put("value", Quantities.forStorage(data.optDouble("unitValue", 0d)));
        values.put("min_stock", Quantities.forStorage(data.optDouble("minStock", 0d)));
        values.put("unit", optString(data, "unit"));
        values.put("category", optString(data, "category"));
        values.put("supplier", optString(data, "supplier"));
        values.put("location", optString(data, "location"));
        values.put("sku", optString(data, "sku"));
        values.put("barcode", optString(data, "barcode"));
        values.put("rev", data.optLong("rev", 0L));
        values.put("updated_at", data.optLong("updatedAt", System.currentTimeMillis()));

        if (excluido) {
            values.put("deleted_at", data.optLong("deletedAt", System.currentTimeMillis()));
        } else {
            values.putNull("deleted_at");
        }

        if (exists(LocalDb.TABLE_PRODUCTS, uuid)) {
            // A quantidade fica de fora da atualização de propósito: ela é
            // consequência das movimentações, que chegam como alterações
            // próprias. Sobrescrever aqui poderia desfazer o efeito de um
            // movimento que já foi aplicado nesta mesma passada.
            db.update(LocalDb.TABLE_PRODUCTS, values, "uuid=?", new String[]{uuid});
        } else {
            values.put("amount", Quantities.forStorage(data.optDouble("quantity", 0d)));
            db.insert(LocalDb.TABLE_PRODUCTS, null, values);
        }
        return Efeito.APLICADA;
    }

    private Efeito applyMovement(JSONObject data) {
        String uuid = data.optString("id", null);
        if (uuid == null) {
            return Efeito.IGNORADA;
        }
        movimentacoesVistas.add(uuid);

        // O aparelho recebe de volta as movimentações que ele mesmo enviou.
        // Reconhecer que a linha já existe é o que impede o saldo de ser
        // debitado duas vezes pela mesma saída.
        if (exists(LocalDb.TABLE_MOVEMENTS, uuid)) {
            return Efeito.IGNORADA;
        }

        String productUuid = optString(data, "productId");
        double quantidade = data.optDouble("quantity", 0d);

        ContentValues values = new ContentValues();
        values.put("uuid", uuid);
        values.put("product_uuid", productUuid);
        values.put("product_name", optString(data, "productName"));
        values.put("change_type", data.optString("changeType", MovementRepository.AJUSTE));
        // Chega com sinal e é gravada assim. As regras de leitura já tratam
        // valor negativo em qualquer tipo, então o efeito no saldo continua
        // sendo lido corretamente pelas telas e relatórios.
        values.put("quantity", quantidade);
        values.put("timestamp", data.optLong("occurredAt", System.currentTimeMillis()));
        values.put("updated_at", data.optLong("recordedAt", System.currentTimeMillis()));
        values.put("note", optString(data, "note"));
        // Vínculo de estorno, quando o outro aparelho (ou a carga inicial da
        // nuvem) cancelou uma movimentação. Sem isso, o cancelamento chegava
        // aqui como um evento solto, indistinguível de uma correção qualquer.
        values.put("reverses_uuid", optString(data, "reversesMovementId"));
        values.put("rev", 0);

        if (db.insert(LocalDb.TABLE_MOVEMENTS, null, values) < 0) {
            return Efeito.IGNORADA;
        }

        if (productUuid != null) {
            double atual = amountOf(productUuid);
            ContentValues produto = new ContentValues();
            produto.put("amount", Quantities.forStorage(atual + quantidade));
            db.update(LocalDb.TABLE_PRODUCTS, produto, "uuid=?", new String[]{productUuid});
        }
        return Efeito.APLICADA;
    }

    /**
     * Marca como excluído o que ficou de fora de uma recarga completa.
     *
     * Só faz sentido depois de varrer o servidor inteiro: o que não apareceu
     * lá não existe mais. O que ainda está na fila de saída é poupado — é
     * alteração local que a nuvem nem chegou a ver.
     *
     * <p>É exclusão suave, com {@code deleted_at}, e não {@code DELETE}. Esta
     * é a única operação do app que decide sozinha apagar produtos e histórico
     * do usuário, a partir de <b>ausência</b> — de algo que o servidor não
     * disse. Basta uma resposta incompleta, uma empresa errada ou um bug no
     * outro lado para que a ausência signifique a coisa errada, e um DELETE
     * não tem volta. Marcado, o registro some das listas e continua no arquivo,
     * recuperável pela restauração de cópia.
     *
     * <p>Pela mesma razão, uma recarga que não trouxe alteração nenhuma não
     * remove nada. Servidor vazio e servidor mudo chegam aqui idênticos, e
     * entre esvaziar o estoque de alguém e não fazer nada, não fazer nada é a
     * resposta certa.
     */
    public int removeAusentes() {
        if (recebidasNoTotal == 0) {
            Log.w(TAG, "recarga sem nenhuma alteração recebida; nada será marcado como excluído");
            return 0;
        }

        int removidos = 0;
        long agora = System.currentTimeMillis();

        db.beginTransaction();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE uuid IS NOT NULL AND deleted_at IS NULL", null);
            while (cursor.moveToNext()) {
                String uuid = cursor.getString(0);
                if (produtosVistos.contains(uuid) || outbox.hasPending(uuid)) {
                    continue;
                }

                ContentValues movimentacao = new ContentValues();
                movimentacao.put("deleted_at", agora);
                db.update(LocalDb.TABLE_MOVEMENTS, movimentacao,
                        "product_uuid=? AND deleted_at IS NULL", new String[]{uuid});

                ContentValues produto = new ContentValues();
                produto.put("deleted_at", agora);
                produto.put("updated_at", agora);
                db.update(LocalDb.TABLE_PRODUCTS, produto, "uuid=?", new String[]{uuid});
                removidos++;
            }
            db.setTransactionSuccessful();
        } catch (Exception e) {
            Log.e(TAG, "falha ao marcar registros ausentes na recarga", e);
        } finally {
            LocalDb.closeQuietly(cursor);
            db.endTransaction();
        }

        return removidos;
    }

    private boolean exists(String tabela, String uuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT 1 FROM " + tabela + " WHERE uuid=? LIMIT 1",
                    new String[]{uuid});
            return cursor.moveToFirst();
        } catch (Exception e) {
            return false;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private double amountOf(String uuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT amount FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=?",
                    new String[]{uuid});
            return cursor.moveToFirst() ? Quantities.parse(cursor.getString(0)) : 0d;
        } catch (Exception e) {
            return 0d;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private static String optString(JSONObject json, String campo) {
        return json.isNull(campo) ? null : json.optString(campo, null);
    }
}
