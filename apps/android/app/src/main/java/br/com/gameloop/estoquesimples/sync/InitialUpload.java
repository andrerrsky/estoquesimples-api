package br.com.gameloop.estoquesimples.sync;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.SyncMeta;

/**
 * Primeira carga do banco local para a nuvem.
 *
 * Precisa ser retomável porque não é uma requisição, é milhares de registros
 * saindo de um celular por uma rede móvel. Interrupção é o caso comum, não a
 * exceção: a tela apaga, o app vai para segundo plano, o sinal cai no elevador.
 *
 * A retomada é possível porque o identificador de cada registro foi gerado no
 * aparelho antes do envio. Um lote reenviado colide nas chaves que já existem e
 * não faz nada, então repetir é sempre seguro — e é por isso que o índice do
 * próximo lote pode ser guardado localmente sem medo de perder ou duplicar.
 */
public final class InitialUpload {

    private static final String TAG = "InitialUpload";

    private final SQLiteDatabase db;
    private final ApiClient api;
    private final SessionManager session;
    private final SyncMeta meta;
    private final int batchSize;

    public InitialUpload(SQLiteDatabase db, ApiClient api, SessionManager session, int batchSize) {
        this.db = db;
        this.api = api;
        this.session = session;
        this.meta = new SyncMeta(db);
        this.batchSize = batchSize;
    }

    /** Acompanhamento para a tela de status. */
    public interface Progress {
        void onProgress(int enviados, int total);
    }

    public static final class Counts {
        public final int produtos;
        public final int movimentacoes;

        Counts(int produtos, int movimentacoes) {
            this.produtos = produtos;
            this.movimentacoes = movimentacoes;
        }

        public int total() {
            return produtos + movimentacoes;
        }
    }

    public Counts counts() {
        return new Counts(
                count("SELECT COUNT(*) FROM " + LocalDb.TABLE_PRODUCTS),
                count("SELECT COUNT(*) FROM " + LocalDb.TABLE_MOVEMENTS));
    }

    public boolean isComplete() {
        return meta.getBoolean(SyncMeta.CARGA_INICIAL_CONCLUIDA, false);
    }

    /**
     * Executa (ou retoma) o envio inicial.
     *
     * @return o cursor devolvido pelo servidor, ponto de partida do modo
     *         incremental.
     */
    public String run(Progress progress) throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            throw new ApiException(0, "SEM_EMPRESA",
                    "Escolha uma empresa antes de sincronizar.", null);
        }

        Counts counts = counts();
        String uploadId = meta.get(SyncMeta.UPLOAD_ID);
        int proximoLote = (int) meta.getLong(SyncMeta.UPLOAD_PROXIMO_LOTE, 0);

        if (uploadId == null) {
            uploadId = openSession(workspaceId, counts);
            proximoLote = 0;
            // Gravados juntos: uma sessão sem índice, ou um índice sem sessão,
            // faria a retomada começar do lugar errado.
            db.beginTransaction();
            try {
                meta.put(SyncMeta.UPLOAD_ID, uploadId);
                meta.put(SyncMeta.UPLOAD_PROXIMO_LOTE, 0L);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }

        int totalLotes = (counts.total() + batchSize - 1) / batchSize;
        for (int indice = proximoLote; indice < totalLotes; indice++) {
            JSONObject lote = buildBatch(indice);
            sendBatch(workspaceId, uploadId, indice, lote);

            meta.put(SyncMeta.UPLOAD_PROXIMO_LOTE, (long) (indice + 1));
            if (progress != null) {
                progress.onProgress(Math.min((indice + 1) * batchSize, counts.total()),
                        counts.total());
            }
        }

        String cursor = complete(workspaceId, uploadId, counts);

        db.beginTransaction();
        try {
            meta.put(SyncMeta.CURSOR, cursor);
            meta.put(SyncMeta.CARGA_INICIAL_CONCLUIDA, true);
            meta.put(SyncMeta.WORKSPACE_ID, workspaceId);
            meta.remove(SyncMeta.UPLOAD_ID);
            meta.remove(SyncMeta.UPLOAD_PROXIMO_LOTE);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }

        Log.i(TAG, "carga inicial concluída com " + counts.total() + " registros");
        return cursor;
    }

    private String openSession(String workspaceId, Counts counts) throws ApiException {
        try {
            JSONObject body = new JSONObject();
            body.put("declaredProducts", counts.produtos);
            body.put("declaredMovements", counts.movimentacoes);
            body.put("batchSize", batchSize);
            body.put("deviceId", session.deviceId());

            ApiClient.Response response = api.post(
                    "/v1/workspaces/" + workspaceId + "/sync/initial-upload",
                    body, session.accessToken());
            return response.body.getString("uploadId");
        } catch (JSONException e) {
            throw new ApiException(0, "RESPOSTA_INVALIDA",
                    "O servidor não devolveu a sessão de envio.", null);
        }
    }

    private void sendBatch(String workspaceId, String uploadId, int indice, JSONObject lote)
            throws ApiException {
        // A chave de idempotência é derivada da sessão e do índice, não
        // sorteada: um reenvio do mesmo lote precisa apresentar a mesma chave,
        // senão o servidor o trataria como um lote novo.
        String chave = uploadId + ":" + indice;
        api.postIdempotent(
                "/v1/workspaces/" + workspaceId + "/sync/initial-upload/" + uploadId + "/batch",
                lote, session.accessToken(), chave);
    }

    private String complete(String workspaceId, String uploadId, Counts counts)
            throws ApiException {
        try {
            JSONObject body = new JSONObject();
            body.put("declaredProducts", counts.produtos);
            body.put("declaredMovements", counts.movimentacoes);

            ApiClient.Response response = api.post(
                    "/v1/workspaces/" + workspaceId + "/sync/initial-upload/" + uploadId
                            + "/complete",
                    body, session.accessToken());
            return response.body.getString("cursor");
        } catch (JSONException e) {
            throw new ApiException(0, "RESPOSTA_INVALIDA",
                    "O servidor não devolveu o ponto de partida da sincronização.", null);
        }
    }

    /**
     * Monta um lote.
     *
     * Produtos vêm antes das movimentações. A paginação usa keyset
     * ({@code id > ultimo}) em vez de OFFSET: durante o envio o usuário pode
     * inserir ou apagar linhas, e OFFSET deslocaria a janela pulando registros
     * em silêncio.
     */
    private JSONObject buildBatch(int indice) throws ApiException {
        int totalProdutos = count("SELECT COUNT(*) FROM " + LocalDb.TABLE_PRODUCTS);
        int start = indice * batchSize;

        JSONArray produtos = new JSONArray();
        JSONArray movimentacoes = new JSONArray();

        int restante = batchSize;
        if (start < totalProdutos) {
            long aposId = nthProductId(start);
            readProductsAfter(produtos, aposId, restante);
            restante -= produtos.length();
        }
        if (restante > 0) {
            int startMov = Math.max(0, start - totalProdutos);
            long aposId = nthMovementId(startMov);
            readMovementsAfter(movimentacoes, aposId, restante);
        }

        try {
            JSONObject lote = new JSONObject();
            lote.put("batchIndex", indice);
            lote.put("products", produtos);
            lote.put("movements", movimentacoes);
            return lote;
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Falha ao montar o lote.", null);
        }
    }

    /** id imediatamente anterior à posição {@code offset} (0 → 0). */
    private long nthProductId(int offset) {
        if (offset <= 0) {
            return 0L;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT id FROM " + LocalDb.TABLE_PRODUCTS
                            + " ORDER BY id LIMIT 1 OFFSET " + (offset - 1),
                    null);
            return cursor.moveToFirst() ? cursor.getLong(0) : Long.MAX_VALUE;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private long nthMovementId(int offset) {
        if (offset <= 0) {
            return 0L;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT id FROM " + LocalDb.TABLE_MOVEMENTS
                            + " ORDER BY id LIMIT 1 OFFSET " + (offset - 1),
                    null);
            return cursor.moveToFirst() ? cursor.getLong(0) : Long.MAX_VALUE;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private void readProductsAfter(JSONArray destino, long aposId, int limite) throws ApiException {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid, name, description, amount, value, category, sku, barcode, "
                            + "supplier, location, min_stock, unit, updated_at, deleted_at, rev "
                            + "FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE id > ? ORDER BY id LIMIT ?",
                    new String[]{String.valueOf(aposId), String.valueOf(limite)});
            while (cursor.moveToNext()) {
                JSONObject produto = new JSONObject();
                produto.put("id", cursor.getString(0));
                produto.put("name", cursor.getString(1));
                produto.put("description", cursor.getString(2));
                produto.put("quantity", parse(cursor.getString(3)));
                produto.put("unitValue", parse(cursor.getString(4)));
                produto.put("category", cursor.getString(5));
                produto.put("sku", cursor.getString(6));
                produto.put("barcode", cursor.getString(7));
                produto.put("supplier", cursor.getString(8));
                produto.put("location", cursor.getString(9));
                produto.put("minStock", parse(cursor.getString(10)));
                produto.put("unit", cursor.getString(11));
                produto.put("updatedAt", cursor.getLong(12));
                produto.put("deletedAt", cursor.isNull(13) ? JSONObject.NULL : cursor.getLong(13));
                produto.put("rev", cursor.getLong(14));
                destino.put(produto);
            }
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Falha ao ler os produtos.", null);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private void readMovementsAfter(JSONArray destino, long aposId, int limite) throws ApiException {
        Cursor cursor = null;
        try {
            // A quantidade sobe com sinal. Localmente uma saída é positiva e o
            // sentido vem do tipo; no servidor o efeito no saldo é lido direto
            // do número, então a conversão precisa acontecer aqui.
            cursor = db.rawQuery(
                    "SELECT uuid, product_uuid, product_name, change_type, "
                            + MovementRepository.SIGNED_QUANTITY_SQL + ", timestamp, "
                            + "note, reverses_uuid FROM " + LocalDb.TABLE_MOVEMENTS
                            + " WHERE id > ? ORDER BY id LIMIT ?",
                    new String[]{String.valueOf(aposId), String.valueOf(limite)});
            while (cursor.moveToNext()) {
                JSONObject movimentacao = new JSONObject();
                movimentacao.put("id", cursor.getString(0));
                // Movimentações órfãs sobem assim mesmo, sem produto. São
                // registros verdadeiros de algo que aconteceu, e descartá-las
                // no envio apagaria histórico que o usuário ainda consulta.
                movimentacao.put("productId",
                        cursor.isNull(1) ? JSONObject.NULL : cursor.getString(1));
                movimentacao.put("productName", cursor.getString(2));
                movimentacao.put("changeType", cursor.getString(3));
                movimentacao.put("quantity", cursor.getDouble(4));
                movimentacao.put("occurredAt", cursor.getLong(5));
                movimentacao.put("note", cursor.isNull(6) ? JSONObject.NULL : cursor.getString(6));
                movimentacao.put("reversesMovementId",
                        cursor.isNull(7) ? JSONObject.NULL : cursor.getString(7));
                destino.put(movimentacao);
            }
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Falha ao ler as movimentações.", null);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private double parse(String valor) {
        return br.com.gameloop.estoquesimples.data.Quantities.parse(valor);
    }

    private int count(String sql) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(sql, null);
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (Exception e) {
            return 0;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }
}
