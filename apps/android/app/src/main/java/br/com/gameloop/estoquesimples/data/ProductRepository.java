package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Acesso a produtos identificados por {@code uuid}.
 *
 * A razão de existir deste repositório é eliminar o {@code WHERE name=?} que
 * estava espalhado pelas telas. Endereçar um produto pelo nome tem duas
 * consequências ruins que já afetam usuários hoje: renomear desliga o produto
 * do próprio histórico, e dois produtos com o mesmo nome são alterados ou
 * apagados juntos.
 */
public final class ProductRepository {

    private static final String TAG = "ProductRepository";

    private final SQLiteDatabase db;

    public ProductRepository(SQLiteDatabase db) {
        this.db = db;
    }

    // -------------------------------------------------------------------------
    // Consultas
    // -------------------------------------------------------------------------

    /**
     * Resolve o identificador estável a partir do nome.
     *
     * Ponte para as telas que ainda navegam por nome (a lista principal passa o
     * nome para a tela de edição, por exemplo). Quando há nomes repetidos,
     * devolve o mais antigo — mesmo critério que o comportamento atual, que
     * pegava a primeira linha.
     */
    public String findUuidByName(String name) {
        if (name == null) {
            return null;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE name=? AND " + LocalDb.ACTIVE_PRODUCTS
                            + " ORDER BY id LIMIT 1",
                    new String[]{name});
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        } catch (Exception e) {
            Log.e(TAG, "falha ao resolver uuid do produto", e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    public Product findByUuid(String uuid) {
        if (uuid == null) {
            return null;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT * FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=? LIMIT 1",
                    new String[]{uuid});
            return cursor.moveToFirst() ? Product.from(cursor) : null;
        } catch (Exception e) {
            Log.e(TAG, "falha ao carregar produto", e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /** Quantidade atual lida do banco, nunca de uma lista em memória. */
    public double currentAmount(String uuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT amount FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=?",
                    new String[]{uuid});
            if (cursor.moveToFirst()) {
                return Quantities.parse(cursor.getString(0));
            }
            return 0d;
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler quantidade", e);
            return 0d;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    public boolean existsByName(String name) {
        return findUuidByName(name) != null;
    }

    public boolean existsByUuid(String uuid) {
        return findByUuid(uuid) != null;
    }

    /**
     * SKU preenchido é o melhor âncora para reimportar uma planilha: o nome
     * muda, o código de barras às vezes falta, o SKU é o que a loja já usa
     * para o mesmo item. SKU vazio não casa com ninguém — senão todos os
     * produtos sem código virariam o mesmo.
     */
    public String findUuidBySku(String sku) {
        return findUuidByNonEmpty("sku", sku);
    }

    public String findUuidByBarcode(String barcode) {
        return findUuidByNonEmpty("barcode", barcode);
    }

    private String findUuidByNonEmpty(String column, String value) {
        if (!"sku".equals(column) && !"barcode".equals(column)) {
            return null;
        }
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE " + column + "=? AND TRIM(" + column + ") <> '' AND "
                            + LocalDb.ACTIVE_PRODUCTS
                            + " ORDER BY id LIMIT 1",
                    new String[]{trimmed});
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        } catch (Exception e) {
            Log.e(TAG, "falha ao resolver produto por " + column, e);
            return null;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Verifica duplicidade de nome ignorando um produto específico. Usada na
     * edição, onde manter o próprio nome não pode contar como conflito.
     */
    public boolean nameTakenByOther(String name, String ownUuid) {
        if (name == null) {
            return false;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT 1 FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE name=? AND " + LocalDb.ACTIVE_PRODUCTS
                            + " AND (uuid IS NULL OR uuid <> ?) LIMIT 1",
                    new String[]{name, ownUuid == null ? "" : ownUuid});
            return cursor.moveToFirst();
        } catch (Exception e) {
            Log.e(TAG, "falha ao verificar nome duplicado", e);
            return false;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    public List<String> allUuids() {
        List<String> uuids = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS + " AND uuid IS NOT NULL",
                    null);
            while (cursor.moveToNext()) {
                uuids.add(cursor.getString(0));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar produtos", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return uuids;
    }

    // -------------------------------------------------------------------------
    // Escrita
    // -------------------------------------------------------------------------

    /**
     * Insere um produto e devolve o uuid gerado.
     *
     * O uuid é criado no aparelho, não pelo servidor. Isso é o que permite
     * cadastrar produtos sem rede e, mais tarde, enviar o mesmo registro
     * quantas vezes for preciso sem duplicar nada do outro lado.
     */
    public String insert(ContentValues values) {
        String uuid = values.getAsString("uuid");
        if (uuid == null || uuid.trim().isEmpty() || !isUuid(uuid)) {
            uuid = UUID.randomUUID().toString();
        }
        values.put("uuid", uuid);
        values.put("updated_at", System.currentTimeMillis());
        values.put("rev", 0);
        values.putNull("deleted_at");

        long id = db.insert(LocalDb.TABLE_PRODUCTS, null, values);
        if (id < 0) {
            Log.e(TAG, "falha ao inserir produto");
            return null;
        }
        // Produto novo não tem versão de origem: não existe nada na nuvem para
        // esta edição ter partido.
        if (!enqueueUpsert(uuid, null, null)) {
            return null;
        }
        return uuid;
    }

    /**
     * Cria o produto e o evento de saldo inicial na mesma transação.
     *
     * Cadastro e importação já nasciam com quantidade preenchida, mas sem
     * nenhuma movimentação correspondente. O resultado é um histórico que nunca
     * soma o saldo do produto: sobrava uma diferença silenciosa igual à
     * quantidade inicial, que ninguém conseguia explicar depois. Com o evento,
     * a soma das movimentações reproduz o saldo desde o primeiro dia.
     *
     * @param changeType {@link MovementRepository#CADASTRO} ou
     *                   {@link MovementRepository#IMPORTACAO}.
     */
    public String create(ContentValues values, String changeType) {
        double initialAmount = Quantities.parse(values.getAsString("amount"));
        String name = values.getAsString("name");

        db.beginTransaction();
        try {
            String uuid = insert(values);
            if (uuid == null) {
                return null;
            }
            if (new MovementRepository(db)
                    .recordInitialBalance(uuid, name, initialAmount, changeType) == null
                    && initialAmount != 0d) {
                return null;
            }
            db.setTransactionSuccessful();
            return uuid;
        } catch (Exception e) {
            Log.e(TAG, "falha ao cadastrar produto", e);
            return null;
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Atualiza um produto pelo identificador estável.
     *
     * {@code rev} é incrementado a cada alteração. Hoje serve como contador
     * local; na sincronização é o que permite detectar que dois aparelhos
     * partiram da mesma versão e editaram o mesmo produto.
     *
     * <p>A transação é aberta aqui dentro, e não deixada a cargo de quem chama.
     * A documentação antiga pedia que o chamador desfizesse a transação num
     * retorno falso, mas as edições em massa da tela principal chamavam o
     * método sem transação nenhuma: uma falha ao enfileirar deixava a linha
     * alterada e nenhuma operação para levá-la à nuvem. Transação aninhada na
     * mesma conexão é barata, então quem já abriu uma continua funcionando
     * igual.
     */
    public boolean update(String uuid, ContentValues values) {
        if (uuid == null) {
            Log.w(TAG, "tentativa de atualizar produto sem uuid");
            return false;
        }
        values.put("updated_at", System.currentTimeMillis());

        db.beginTransaction();
        try {
            // A versão de origem é lida antes da alteração. É ela que a nuvem
            // compara para saber se esta edição partiu do estado atual ou por
            // cima do trabalho de outra pessoa; enviar a versão já incrementada
            // faria toda edição parecer conflito.
            long baseRev = revOf(uuid);

            // Junto vai o que havia em cada campo tocado. É isso que permite ao
            // servidor mesclar duas edições que não se cruzam, em vez de
            // escolher um vencedor e descartar o trabalho do outro.
            JSONObject anterior = SyncPayloads.previousValues(db, uuid, values.keySet());

            int rows = db.update(LocalDb.TABLE_PRODUCTS, values, "uuid=?", new String[]{uuid});
            if (rows == 0) {
                return false;
            }
            db.execSQL("UPDATE " + LocalDb.TABLE_PRODUCTS + " SET rev = rev + 1 WHERE uuid=?",
                    new String[]{uuid});
            if (!enqueueUpsert(uuid, baseRev, anterior)) {
                return false;
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "falha ao atualizar produto", e);
            return false;
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Marca o produto como excluído em vez de apagar a linha.
     *
     * A exclusão física deixava o histórico órfão de forma definitiva. Com a
     * marcação, as movimentações continuam apontando para um produto que ainda
     * existe no banco, os relatórios históricos seguem corretos, e o produto
     * simplesmente deixa de aparecer nas listagens.
     *
     * <p>Como em {@link #update}, a marcação e a operação de envio ficam na
     * mesma transação aberta aqui.
     */
    public boolean softDelete(String uuid) {
        if (uuid == null) {
            return false;
        }
        long now = System.currentTimeMillis();

        db.beginTransaction();
        try {
            long baseRev = revOf(uuid);

            ContentValues values = new ContentValues();
            values.put("deleted_at", now);
            values.put("updated_at", now);

            int rows = db.update(LocalDb.TABLE_PRODUCTS, values,
                    "uuid=? AND deleted_at IS NULL", new String[]{uuid});
            if (rows == 0) {
                return false;
            }
            db.execSQL("UPDATE " + LocalDb.TABLE_PRODUCTS + " SET rev = rev + 1 WHERE uuid=?",
                    new String[]{uuid});

            if (SyncGate.shouldEnqueue()) {
                // A exclusão viaja como lápide, não como ausência: um registro
                // que simplesmente some do envio seria indistinguível de um
                // registro que nunca existiu, e os outros aparelhos o manteriam
                // para sempre.
                JSONObject payload = SyncPayloads.productTombstone(uuid, now, revOf(uuid));
                if (payload == null || new OutboxRepository(db).enqueue(
                        OutboxRepository.ENTITY_PRODUTO, uuid,
                        OutboxRepository.OP_DELETE, baseRev, payload.toString()) == null) {
                    return false;
                }
            }

            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "falha ao excluir produto", e);
            return false;
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Enfileira o estado atual do produto.
     *
     * Devolve {@code false} se a operação não pôde ser gravada, para que a
     * transação inteira seja desfeita. Salvar a alteração e perder a operação
     * faria o aparelho mostrar um valor que a nuvem nunca receberia.
     */
    private boolean enqueueUpsert(String uuid, Long baseRev, JSONObject anterior) {
        if (!SyncGate.shouldEnqueue()) {
            return true;
        }
        JSONObject payload = SyncPayloads.product(db, uuid, anterior);
        if (payload == null) {
            return false;
        }
        return new OutboxRepository(db).enqueue(
                OutboxRepository.ENTITY_PRODUTO, uuid,
                OutboxRepository.OP_UPSERT, baseRev, payload.toString()) != null;
    }

    static boolean isUuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            UUID.fromString(value.trim());
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private long revOf(String uuid) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT rev FROM " + LocalDb.TABLE_PRODUCTS + " WHERE uuid=?",
                    new String[]{uuid});
            return cursor.moveToFirst() ? cursor.getLong(0) : 0L;
        } catch (Exception e) {
            return 0L;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Desfaz uma exclusão.
     *
     * Restaurar é uma alteração como qualquer outra e precisa viajar como tal.
     * Limpar o {@code deleted_at} em silêncio ressuscitava o produto só neste
     * aparelho: para os outros ele continuava excluído e, na leitura seguinte,
     * a lápide que ainda estava na nuvem voltava e o apagava de novo aqui.
     */
    public boolean restore(String uuid) {
        if (uuid == null) {
            return false;
        }
        db.beginTransaction();
        try {
            long baseRev = revOf(uuid);

            ContentValues values = new ContentValues();
            values.putNull("deleted_at");
            values.put("updated_at", System.currentTimeMillis());

            int rows = db.update(LocalDb.TABLE_PRODUCTS, values,
                    "uuid=? AND deleted_at IS NOT NULL", new String[]{uuid});
            if (rows == 0) {
                return false;
            }
            db.execSQL("UPDATE " + LocalDb.TABLE_PRODUCTS + " SET rev = rev + 1 WHERE uuid=?",
                    new String[]{uuid});
            if (!enqueueUpsert(uuid, baseRev, null)) {
                return false;
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "falha ao restaurar produto", e);
            return false;
        } finally {
            db.endTransaction();
        }
    }
}
