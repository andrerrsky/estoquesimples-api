package br.com.gameloop.estoquesimples.data;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Monta o corpo das operações que vão para a fila de saída.
 *
 * O conteúdo é lido do banco <b>depois</b> da alteração e dentro da mesma
 * transação, e não montado a partir dos valores que a tela enviou. Assim a
 * operação carrega exatamente o que ficou gravado — incluindo campos que a tela
 * não tocou e o {@code rev} resultante. Montar a partir do formulário faria a
 * nuvem receber uma versão do registro que nunca existiu no aparelho.
 */
final class SyncPayloads {

    private static final String TAG = "SyncPayloads";

    private SyncPayloads() {
    }

    /**
     * Colunas do banco local e o nome que cada uma tem no contrato da nuvem.
     *
     * Existe para montar o ponto de partida da edição: o servidor precisa
     * saber quais campos mudaram e o que havia neles antes, senão não tem como
     * distinguir "só eu mexi neste campo" de "nós dois mexemos".
     */
    private static final String[][] CAMPOS_SINCRONIZADOS = {
            {"name", "name"},
            {"description", "description"},
            {"value", "unitValue"},
            {"min_stock", "minStock"},
            {"unit", "unit"},
            {"category", "category"},
            {"supplier", "supplier"},
            {"location", "location"},
            {"sku", "sku"},
            {"barcode", "barcode"},
    };

    /**
     * Colunas cujo valor anterior sobe como número.
     *
     * Um conjunto, e não um texto com {@code contains}: a busca por substring
     * casava com qualquer pedaço, então uma coluna chamada "min" ou "value_x"
     * passaria por numérica sem ninguém perceber.
     */
    private static final Set<String> COLUNAS_NUMERICAS =
            new HashSet<>(Arrays.asList("value", "min_stock"));

    /**
     * Valores que os campos prestes a mudar têm agora.
     *
     * Precisa ser chamado <b>antes</b> do UPDATE: depois, o valor de partida já
     * não existe em lugar nenhum.
     */
    static JSONObject previousValues(SQLiteDatabase db, String uuid, Set<String> colunasAlteradas) {
        if (colunasAlteradas == null || colunasAlteradas.isEmpty()) {
            return null;
        }

        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT * FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=?",
                    new String[]{uuid});
            if (!cursor.moveToFirst()) {
                return null;
            }

            JSONObject anterior = new JSONObject();
            for (String[] campo : CAMPOS_SINCRONIZADOS) {
                if (!colunasAlteradas.contains(campo[0])) {
                    continue;
                }
                int indice = cursor.getColumnIndex(campo[0]);
                if (indice < 0) {
                    continue;
                }
                if (cursor.isNull(indice)) {
                    anterior.put(campo[1], JSONObject.NULL);
                } else if (COLUNAS_NUMERICAS.contains(campo[0])) {
                    anterior.put(campo[1], Quantities.parse(cursor.getString(indice)));
                } else {
                    anterior.put(campo[1], cursor.getString(indice));
                }
            }
            return anterior.length() > 0 ? anterior : null;

        } catch (JSONException e) {
            Log.e(TAG, "falha ao ler o estado anterior de " + uuid, e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    static JSONObject product(SQLiteDatabase db, String uuid) {
        return product(db, uuid, null);
    }

    static JSONObject product(SQLiteDatabase db, String uuid, JSONObject previous) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT * FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=?",
                    new String[]{uuid});
            if (!cursor.moveToFirst()) {
                return null;
            }
            Product product = Product.from(cursor);

            JSONObject json = new JSONObject();
            json.put("id", product.uuid);
            json.put("name", product.name);
            json.put("description", product.description);
            json.put("quantity", product.amountAsNumber());
            json.put("unitValue", Quantities.parse(product.value));
            json.put("category", product.category);
            json.put("sku", product.sku);
            json.put("barcode", product.barcode);
            json.put("supplier", product.supplier);
            json.put("location", product.location);
            json.put("minStock", Quantities.parse(product.minStock));
            json.put("unit", product.unit);
            json.put("rev", product.rev);
            json.put("updatedAt", product.updatedAt);
            if (previous != null && previous.length() > 0) {
                json.put("previous", previous);
            }
            // O caminho da foto é local e não viaja. O que viaja é o hash da
            // imagem na nuvem, e só quando esta operação mexe na foto (o
            // "previous" traz photoHash): ausente = "não toquei na foto", e um
            // aparelho que não enviou a imagem nunca pode apagá-la por omissão.
            if (PhotoPayloads.touchesPhoto(previous)) {
                PhotoPayloads.attach(json, product.photoHash);
            }
            return json;

        } catch (JSONException e) {
            Log.e(TAG, "falha ao montar o produto " + uuid, e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    static JSONObject productTombstone(String uuid, long deletedAt, long rev) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", uuid);
            json.put("deletedAt", deletedAt);
            json.put("rev", rev);
            return json;
        } catch (JSONException e) {
            return null;
        }
    }

    static JSONObject movement(SQLiteDatabase db, String uuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid, product_uuid, change_type, quantity, timestamp, note, "
                            + "reverses_uuid "
                            + "FROM " + LocalDb.TABLE_MOVEMENTS + " WHERE uuid=?",
                    new String[]{uuid});
            if (!cursor.moveToFirst()) {
                return null;
            }

            String changeType = cursor.getString(2);

            JSONObject json = new JSONObject();
            json.put("id", cursor.getString(0));
            json.put("productId", cursor.getString(1));
            json.put("changeType", changeType);
            // Com sinal. No aparelho, uma saída é gravada como quantidade
            // positiva e o sentido vem do tipo — convenção herdada do banco
            // antigo. Enviar assim faria o servidor somar ao estoque o que
            // deveria subtrair, e o saldo divergiria sem nenhum erro visível.
            json.put("quantity",
                    MovementRepository.signedQuantity(changeType, cursor.getDouble(3)));
            // O horário do aparelho vai como informação; a ordenação de verdade
            // é a sequência atribuída pelo servidor.
            json.put("occurredAt", cursor.getLong(4));
            json.put("note", cursor.isNull(5) ? JSONObject.NULL : cursor.getString(5));
            // Vínculo estruturado do cancelamento com a movimentação original.
            // Sem isso, um estorno feito neste aparelho chega aos outros como
            // mais um evento solto — quem olha o histórico lá não tem como
            // saber que ele anula outro.
            json.put("reversesMovementId",
                    cursor.isNull(6) ? JSONObject.NULL : cursor.getString(6));
            return json;

        } catch (JSONException e) {
            Log.e(TAG, "falha ao montar a movimentação " + uuid, e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }
}
