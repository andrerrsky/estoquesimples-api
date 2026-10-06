package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Ponto único de abertura e evolução do banco local.
 *
 * Antes desta classe, seis telas chamavam {@code openOrCreateDatabase} por
 * conta própria e cada uma repetia os {@code CREATE TABLE} e os
 * {@code ALTER TABLE} dentro de try/catch. Isso funcionava, mas significava
 * que o schema real dependia de qual tela o usuário abriu primeiro — e não
 * havia como saber em que versão um aparelho estava.
 *
 * Aqui o schema passa a ter uma versão explícita ({@code user_version}) e um
 * caminho de migração determinístico.
 *
 * <p><b>Sobre a adoção do banco legado:</b> bancos criados pela versão antiga
 * ficaram com {@code user_version = 0}. O {@link SQLiteOpenHelper} não
 * consegue distinguir isso de um banco recém-criado e chama {@code onCreate}
 * nos dois casos. Por isso {@code onCreate} usa {@code CREATE TABLE IF NOT
 * EXISTS} e em seguida roda exatamente as mesmas etapas de migração, todas
 * idempotentes: aplicar sobre um banco cheio de dados é seguro e não perde
 * nada.
 */
public final class LocalDb extends SQLiteOpenHelper {

    private static final String TAG = "LocalDb";

    public static final String DATABASE_NAME = "estoque";

    /**
     * 1 — schema legado (implícito, sem user_version).
     * 2 — identidade estável: uuid, product_uuid, updated_at, deleted_at, rev.
     * 3 — quantidade fracionária: EstoqueHistorico.quantity passa a NUMERIC.
     * 4 — fila de saída e estado de sincronização.
     * 5 — cancelamento idempotente, índice da fila por entidade e nova
     *     tentativa de ligar o histórico legado ao produto pelo uuid.
     * 6 — reverses_uuid: vínculo estruturado entre um cancelamento e a
     *     movimentação original, para sincronizar e exibir esse elo.
     * 7 — photo_hash / photo_base_hash: identificação da foto na nuvem (ver
     *     AGENTS.md, "Fotos dos produtos").
     */
    public static final int VERSION = 7;

    public static final String TABLE_PRODUCTS = "Estoque";
    public static final String TABLE_MOVEMENTS = "EstoqueHistorico";
    public static final String TABLE_OUTBOX = "sync_outbox";
    public static final String TABLE_SYNC_META = "sync_meta";

    /** Filtro padrão de produtos visíveis. Exclusão passou a ser suave. */
    public static final String ACTIVE_PRODUCTS = "deleted_at IS NULL";

    /**
     * Junção entre movimentação ({@code h}) e produto ({@code e}).
     *
     * Só pelo identificador estável. A versão anterior tinha um {@code OR} que
     * caía no nome quando o {@code product_uuid} era nulo, e isso custava caro
     * de duas formas: nenhum índice atende a uma condição com {@code OR}, então
     * todo relatório varria as duas tabelas inteiras; e dois produtos legados
     * com o mesmo nome casavam com a mesma movimentação, duplicando a linha e
     * inflando os totais. O backfill do {@code product_uuid} roda de novo na
     * versão 5 do schema para reduzir ao mínimo o que fica sem par.
     */
    public static final String JOIN_MOVEMENT_PRODUCT =
            "LEFT JOIN " + TABLE_PRODUCTS + " e ON e.uuid = h.product_uuid";

    private static LocalDb instance;

    private LocalDb(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, null, VERSION);
    }

    public static synchronized LocalDb helper(Context context) {
        if (instance == null) {
            instance = new LocalDb(context);
        }
        return instance;
    }

    /**
     * Devolve a conexão de escrita compartilhada. O {@link SQLiteOpenHelper}
     * mantém uma única conexão e serializa o acesso, o que já evita boa parte
     * dos problemas que a abertura repetida causava.
     *
     * <p><b>Quem chama nunca deve fechar o retorno.</b> A conexão é única para
     * o processo inteiro e é a mesma que {@code MainActivity.stock} guarda.
     * Fechá-la num {@code finally} — o reflexo natural de quem abriu o banco
     * sozinho — derruba o banco para todas as telas: a partir dali todo
     * {@code isOpen()} devolve falso e as operações passam a ser recusadas.
     * Feche apenas os cursores.
     */
    public static SQLiteDatabase open(Context context) {
        return helper(context).getWritableDatabase();
    }

    /**
     * Fecha a conexão compartilhada para que o arquivo do banco possa ser
     * trocado no disco.
     *
     * A única exceção à regra de nunca fechar a conexão, e existe para a
     * restauração de cópia: sobrescrever o arquivo com a conexão aberta deixa
     * o app lendo páginas de um banco que não existe mais. Quem chama precisa
     * garantir que o app seja reiniciado logo em seguida — qualquer referência
     * guardada por uma tela (a começar por {@code MainActivity.stock}) aponta
     * para a conexão que acabou de ser fechada.
     */
    public static synchronized void closeForFileSwap() {
        if (instance != null) {
            instance.close();
            instance = null;
        }
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        // Chaves estrangeiras não são usadas ainda, mas o WAL melhora leitura
        // concorrente enquanto uma movimentação está sendo gravada.
        db.enableWriteAheadLogging();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        createBaseSchema(db);
        // Também roda no banco legado adotado, por isso precisa ser idempotente.
        upgradeToV2(db);
        upgradeToV3(db);
        upgradeToV4(db);
        upgradeToV5(db);
        upgradeToV6(db);
        upgradeToV7(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        Log.i(TAG, "migrando banco local de " + oldVersion + " para " + newVersion);
        createBaseSchema(db);
        if (oldVersion < 2) {
            upgradeToV2(db);
        }
        if (oldVersion < 3) {
            upgradeToV3(db);
        }
        if (oldVersion < 4) {
            upgradeToV4(db);
        }
        if (oldVersion < 5) {
            upgradeToV5(db);
        }
        if (oldVersion < 6) {
            upgradeToV6(db);
        }
        if (oldVersion < 7) {
            upgradeToV7(db);
        }
    }

    @Override
    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Instalar uma versão anterior do app não pode apagar os dados do
        // usuário. O comportamento padrão do SQLiteOpenHelper é lançar exceção;
        // preferimos seguir com o schema mais novo, que é compatível — colunas
        // a mais não atrapalham a versão antiga. O helper vai gravar o
        // user_version menor; quando a versão nova voltar, onUpgrade repete as
        // etapas, todas idempotentes, e nada é perdido no caminho.
        Log.w(TAG, "banco em versão superior (" + oldVersion + "); mantendo os dados");
    }

    private void createBaseSchema(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_PRODUCTS + " ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                + "name VARCHAR, description VARCHAR, amount VARCHAR, value VARCHAR, "
                + "photo VARCHAR, category VARCHAR, sku VARCHAR, barcode VARCHAR, "
                + "supplier VARCHAR, location VARCHAR, min_stock VARCHAR, unit VARCHAR)");

        db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_MOVEMENTS + " ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                + "product_name VARCHAR, change_type VARCHAR, quantity NUMERIC, "
                + "timestamp INTEGER, note VARCHAR)");

        // Colunas que a versão antiga adicionava uma a uma, cada tela por sua
        // conta. Um aparelho que nunca abriu determinada tela pode não tê-las.
        addColumnIfMissing(db, TABLE_PRODUCTS, "category", "VARCHAR");
        addColumnIfMissing(db, TABLE_PRODUCTS, "sku", "VARCHAR");
        addColumnIfMissing(db, TABLE_PRODUCTS, "barcode", "VARCHAR");
        addColumnIfMissing(db, TABLE_PRODUCTS, "supplier", "VARCHAR");
        addColumnIfMissing(db, TABLE_PRODUCTS, "location", "VARCHAR");
        addColumnIfMissing(db, TABLE_PRODUCTS, "min_stock", "VARCHAR");
        addColumnIfMissing(db, TABLE_PRODUCTS, "unit", "VARCHAR");
    }

    /**
     * Introduz identidade estável.
     *
     * O motivo é anterior a qualquer sincronização: hoje todo UPDATE e DELETE
     * de produto usa {@code WHERE name=?}, e o histórico referencia o produto
     * por nome. Renomear um produto órfã o histórico dele, e dois produtos com
     * o mesmo nome são alterados juntos. Com um identificador que não muda,
     * os dois problemas deixam de existir.
     */
    private void upgradeToV2(SQLiteDatabase db) {
        addColumnIfMissing(db, TABLE_PRODUCTS, "uuid", "TEXT");
        addColumnIfMissing(db, TABLE_PRODUCTS, "updated_at", "INTEGER");
        addColumnIfMissing(db, TABLE_PRODUCTS, "deleted_at", "INTEGER");
        addColumnIfMissing(db, TABLE_PRODUCTS, "rev", "INTEGER NOT NULL DEFAULT 0");

        addColumnIfMissing(db, TABLE_MOVEMENTS, "uuid", "TEXT");
        addColumnIfMissing(db, TABLE_MOVEMENTS, "product_uuid", "TEXT");
        addColumnIfMissing(db, TABLE_MOVEMENTS, "updated_at", "INTEGER");
        addColumnIfMissing(db, TABLE_MOVEMENTS, "deleted_at", "INTEGER");
        addColumnIfMissing(db, TABLE_MOVEMENTS, "rev", "INTEGER NOT NULL DEFAULT 0");

        backfillProductUuids(db);
        backfillMovementUuids(db);
        linkMovementsToProducts(db);

        // Índice único parcial: dois produtos não podem compartilhar uuid, mas
        // linhas antigas ainda sem uuid não impedem a criação do índice.
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS idx_estoque_uuid "
                + "ON " + TABLE_PRODUCTS + " (uuid) WHERE uuid IS NOT NULL");
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS idx_historico_uuid "
                + "ON " + TABLE_MOVEMENTS + " (uuid) WHERE uuid IS NOT NULL");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_historico_produto "
                + "ON " + TABLE_MOVEMENTS + " (product_uuid, timestamp DESC)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_estoque_ativos "
                + "ON " + TABLE_PRODUCTS + " (deleted_at)");
    }

    /**
     * Converte {@code EstoqueHistorico.quantity} de INTEGER para NUMERIC.
     *
     * O app já permite unidades fracionárias (kg, litro, metro), mas a coluna
     * foi declarada como inteiro. Meio quilo sobrevivia por acidente — SQLite
     * não impõe o tipo declarado —, e um dia em que alguém decidisse confiar na
     * declaração o dado seria truncado. Um ledger que arredonda quantidades
     * deixa de fechar com o saldo, então a coluna passa a dizer a verdade.
     *
     * SQLite não altera o tipo de uma coluna existente; a tabela precisa ser
     * reconstruída. Os índices somem junto com o DROP e são recriados aqui.
     *
     * <p>Sem transação própria e sem try/catch de propósito. O
     * {@link SQLiteOpenHelper} já executa {@code onCreate} e {@code onUpgrade}
     * dentro de uma transação, e abrir outra aqui dentro criava um problema
     * pior do que resolvia: uma transação filha encerrada sem sucesso obriga a
     * mãe a voltar atrás inteira. Engolir a exceção então desfazia também as
     * etapas 2 e 4 e deixava o {@code user_version} para trás — o app seguia
     * rodando contra um schema sem {@code deleted_at}, em que toda consulta
     * baseada em {@link #ACTIVE_PRODUCTS} falha. Deixar a falha subir aborta a
     * migração inteira de forma limpa e ela é tentada de novo na próxima
     * abertura, com os dados como estavam.
     */
    private void upgradeToV3(SQLiteDatabase db) {
        if ("NUMERIC".equalsIgnoreCase(declaredType(db, TABLE_MOVEMENTS, "quantity"))) {
            return;
        }

        db.execSQL("DROP TABLE IF EXISTS " + TABLE_MOVEMENTS + "_v3");
        db.execSQL("CREATE TABLE " + TABLE_MOVEMENTS + "_v3 ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                + "uuid TEXT, product_uuid TEXT, product_name VARCHAR, "
                + "change_type VARCHAR, quantity NUMERIC, timestamp INTEGER, "
                + "note VARCHAR, updated_at INTEGER, deleted_at INTEGER, "
                + "rev INTEGER NOT NULL DEFAULT 0)");

        // A vírgula decimal aparece no histórico de quem digitou "1,5":
        // sem trocá-la por ponto, o valor ficaria como texto e sairia como
        // zero em qualquer soma.
        db.execSQL("INSERT INTO " + TABLE_MOVEMENTS + "_v3 ("
                + "id, uuid, product_uuid, product_name, change_type, quantity, "
                + "timestamp, note, updated_at, deleted_at, rev) "
                + "SELECT id, uuid, product_uuid, product_name, change_type, "
                + "CAST(REPLACE(CAST(quantity AS TEXT), ',', '.') AS REAL), "
                + "timestamp, note, updated_at, deleted_at, COALESCE(rev, 0) "
                + "FROM " + TABLE_MOVEMENTS);

        db.execSQL("DROP TABLE " + TABLE_MOVEMENTS);
        db.execSQL("ALTER TABLE " + TABLE_MOVEMENTS + "_v3 RENAME TO " + TABLE_MOVEMENTS);

        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS idx_historico_uuid "
                + "ON " + TABLE_MOVEMENTS + " (uuid) WHERE uuid IS NOT NULL");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_historico_produto "
                + "ON " + TABLE_MOVEMENTS + " (product_uuid, timestamp DESC)");

        Log.i(TAG, "EstoqueHistorico.quantity convertido para NUMERIC");
    }

    /**
     * Cria a fila de saída e o estado de sincronização.
     *
     * A fila é o que permite continuar trabalhando sem rede: toda alteração é
     * gravada junto com a operação correspondente, na mesma transação. Se a
     * gravação local deu certo, a operação existe; se o app for encerrado antes
     * de enviar, ela continua lá na próxima abertura. A alternativa — varrer as
     * tabelas procurando o que mudou desde o último envio — perde exclusões e
     * não distingue duas edições seguidas do mesmo registro.
     *
     * As tabelas são criadas mesmo para quem nunca vai sincronizar. Ficam
     * vazias, custam alguns kilobytes, e evitam um caminho de código que só
     * roda em parte dos aparelhos.
     */
    private void upgradeToV4(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_OUTBOX + " ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                // op_id é gerado no aparelho e viaja com a operação: é ele que
                // permite ao servidor reconhecer um reenvio como duplicata em
                // vez de aplicar a mesma alteração duas vezes.
                + "op_id TEXT NOT NULL UNIQUE, "
                + "entity_type TEXT NOT NULL, "
                + "entity_id TEXT NOT NULL, "
                + "op TEXT NOT NULL, "
                + "base_rev INTEGER, "
                + "payload TEXT NOT NULL, "
                + "created_at INTEGER NOT NULL, "
                + "attempts INTEGER NOT NULL DEFAULT 0, "
                + "next_attempt_at INTEGER NOT NULL DEFAULT 0, "
                + "last_error TEXT, "
                + "status TEXT NOT NULL DEFAULT 'pendente')");

        db.execSQL("CREATE INDEX IF NOT EXISTS idx_outbox_pronto "
                + "ON " + TABLE_OUTBOX + " (status, next_attempt_at, id)");
        // Usado pela compactação, que precisa achar rapidamente as operações
        // pendentes de uma mesma entidade.
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_outbox_entidade "
                + "ON " + TABLE_OUTBOX + " (entity_type, entity_id, status)");

        db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_SYNC_META + " ("
                + "chave TEXT PRIMARY KEY, valor TEXT)");
    }

    /**
     * Cancelamento idempotente, busca na fila por entidade e mais uma tentativa
     * de ligar o histórico legado ao produto.
     *
     * O {@code cancelled_at} existe porque cancelar não apaga a movimentação
     * original: ela continua no histórico e o estorno entra como um evento
     * próprio, para que o saldo continue explicável pelos eventos. Sem uma
     * marca na original, nada impedia cancelá-la de novo, e cada repetição
     * criava outro estorno. A coluna é local; ela não muda a soma do saldo,
     * apenas registra que aquele evento já foi desfeito.
     */
    private void upgradeToV5(SQLiteDatabase db) {
        addColumnIfMissing(db, TABLE_MOVEMENTS, "cancelled_at", "INTEGER");

        // hasPending() filtra por (entity_id, status). O índice da versão 4
        // começa por entity_type, então o SQLite não conseguia usá-lo e cada
        // verificação varria a fila inteira — uma vez por registro recebido.
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_outbox_entidade_id "
                + "ON " + TABLE_OUTBOX + " (entity_id, status)");

        // Repetido de propósito: o backfill da versão 2 rodou antes de a maior
        // parte dos aparelhos ter aberto todas as telas, e a junção dos
        // relatórios deixou de ter o desvio pelo nome. Quanto menos
        // movimentação sem product_uuid, mais completo o relatório fica.
        linkMovementsToProducts(db);
    }

    /**
     * Vínculo estruturado de estorno.
     *
     * Antes, cancelar uma movimentação só deixava rastro numa nota de texto
     * livre ("Cancelamento de entrada"). Isso bastava para o histórico local,
     * mas não sobrevivia à sincronização: um segundo aparelho via só mais uma
     * movimentação solta, sem saber que ela anulava outra. A coluna guarda o
     * uuid da movimentação original; é local e não muda a soma do saldo.
     */
    private void upgradeToV6(SQLiteDatabase db) {
        addColumnIfMissing(db, TABLE_MOVEMENTS, "reverses_uuid", "TEXT");
    }

    /**
     * Fotos na nuvem.
     *
     * {@code photo_hash}: SHA-256 da imagem no servidor que o arquivo local
     * representa; nulo com {@code photo} preenchida significa "ainda precisa
     * subir". {@code photo_base_hash}: o que a nuvem tinha quando a foto local
     * foi trocada, ponto de partida (previous) do envio. Aparelhos que já têm
     * foto ficam com os dois nulos e a foto sobe na próxima sincronização.
     */
    private void upgradeToV7(SQLiteDatabase db) {
        addColumnIfMissing(db, TABLE_PRODUCTS, "photo_hash", "TEXT");
        addColumnIfMissing(db, TABLE_PRODUCTS, "photo_base_hash", "TEXT");
    }

    private void backfillProductUuids(SQLiteDatabase db) {
        List<Integer> ids = idsMissingUuid(db, TABLE_PRODUCTS);
        if (ids.isEmpty()) {
            return;
        }

        // Sem transação própria: as migrações só rodam de dentro da transação
        // que o SQLiteOpenHelper abre, e aninhar outra aqui só cria a chance de
        // uma falha local derrubar a migração inteira de forma silenciosa.
        long now = System.currentTimeMillis();
        for (Integer id : ids) {
            ContentValues values = new ContentValues();
            values.put("uuid", UUID.randomUUID().toString());
            values.put("updated_at", now);
            db.update(TABLE_PRODUCTS, values, "id=?", new String[]{String.valueOf(id)});
        }
        Log.i(TAG, "uuid atribuído a " + ids.size() + " produto(s)");
    }

    private void backfillMovementUuids(SQLiteDatabase db) {
        List<Integer> ids = idsMissingUuid(db, TABLE_MOVEMENTS);
        if (ids.isEmpty()) {
            return;
        }

        for (Integer id : ids) {
            ContentValues values = new ContentValues();
            values.put("uuid", UUID.randomUUID().toString());
            db.update(TABLE_MOVEMENTS, values, "id=?", new String[]{String.valueOf(id)});
        }
        Log.i(TAG, "uuid atribuído a " + ids.size() + " movimentação(ões)");
    }

    /**
     * Liga o histórico existente aos produtos pelo nome — a única informação
     * disponível nos dados legados.
     *
     * Movimentações cujo produto foi renomeado ou excluído não encontram par e
     * ficam com {@code product_uuid} nulo. Elas são <b>preservadas</b>: o
     * registro de que uma saída aconteceu continua sendo verdade mesmo sem
     * saber a qual produto atual ela pertence, e descartá-lo apagaria
     * histórico real do usuário.
     */
    private void linkMovementsToProducts(SQLiteDatabase db) {
        db.execSQL("UPDATE " + TABLE_MOVEMENTS + " SET product_uuid = ("
                + "  SELECT e.uuid FROM " + TABLE_PRODUCTS + " e"
                + "  WHERE e.name = " + TABLE_MOVEMENTS + ".product_name"
                + "  ORDER BY e.id LIMIT 1"
                + ") WHERE product_uuid IS NULL AND product_name IS NOT NULL");

        int orphans = countOrphanMovements(db);
        if (orphans > 0) {
            Log.i(TAG, orphans + " movimentação(ões) sem produto correspondente; preservadas");
        }
    }

    public static int countOrphanMovements(SQLiteDatabase db) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT COUNT(*) FROM " + TABLE_MOVEMENTS + " WHERE product_uuid IS NULL", null);
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao contar movimentações órfãs", e);
            return 0;
        } finally {
            closeQuietly(cursor);
        }
    }

    private List<Integer> idsMissingUuid(SQLiteDatabase db, String table) {
        List<Integer> ids = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT id FROM " + table + " WHERE uuid IS NULL OR uuid = ''", null);
            while (cursor.moveToNext()) {
                ids.add(cursor.getInt(0));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar linhas sem uuid em " + table, e);
        } finally {
            closeQuietly(cursor);
        }
        return ids;
    }

    /**
     * Adiciona a coluna apenas se ela ainda não existir.
     *
     * A versão anterior tentava o {@code ALTER TABLE} e engolia a exceção. Isso
     * funciona, mas polui o log com erros a cada abertura e esconde falhas
     * verdadeiras. Consultar o schema antes deixa claro o que aconteceu.
     */
    public static void addColumnIfMissing(SQLiteDatabase db, String table, String column, String type) {
        if (hasColumn(db, table, column)) {
            return;
        }
        try {
            db.execSQL("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
            Log.i(TAG, "coluna " + table + "." + column + " adicionada");
        } catch (Exception e) {
            Log.e(TAG, "falha ao adicionar coluna " + table + "." + column, e);
        }
    }

    /** Tipo declarado da coluna, ou {@code null} se ela não existir. */
    public static String declaredType(SQLiteDatabase db, String table, String column) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null);
            int nameIndex = cursor.getColumnIndex("name");
            int typeIndex = cursor.getColumnIndex("type");
            while (cursor.moveToNext()) {
                if (column.equalsIgnoreCase(cursor.getString(nameIndex))) {
                    return cursor.getString(typeIndex);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao inspecionar tipo de " + table + "." + column, e);
        } finally {
            closeQuietly(cursor);
        }
        return null;
    }

    public static boolean hasColumn(SQLiteDatabase db, String table, String column) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null);
            int nameIndex = cursor.getColumnIndex("name");
            while (cursor.moveToNext()) {
                if (column.equalsIgnoreCase(cursor.getString(nameIndex))) {
                    return true;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao inspecionar " + table, e);
        } finally {
            closeQuietly(cursor);
        }
        return false;
    }

    public static void closeQuietly(Cursor cursor) {
        if (cursor != null) {
            try {
                cursor.close();
            } catch (Exception ignored) {
                // Fechar cursor nunca deve derrubar a operação que o usou.
            }
        }
    }
}
