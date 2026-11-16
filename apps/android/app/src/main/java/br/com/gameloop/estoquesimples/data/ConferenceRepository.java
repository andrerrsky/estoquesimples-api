package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Conferência de estoque: contagem física comparada com o saldo esperado.
 *
 * Ver docs/conferencia-de-estoque.md. Três decisões moram aqui e explicam o
 * resto do arquivo:
 *
 * 1. **Produto não contado nunca vira zero.** Ele simplesmente não tem linha
 *    em {@code inventory_counts} e, no fechamento, é ignorado. Tratar não
 *    contado como zero zeraria o estoque de quem parou a contagem no meio —
 *    é o erro que destrói dados alheios, e nenhuma comodidade de código
 *    justifica correr esse risco.
 * 2. **Cada item é gravado na hora de contar**, não ao fechar. Uma contagem
 *    de loja inteira leva uma hora; se o app morrer no meio, a sessão fica
 *    {@code open} e é retomada de onde parou.
 * 3. **O esperado e o custo são congelados** no instante da contagem. Se o
 *    produto se mexer durante a conferência, o resultado não muda debaixo de
 *    quem está contando.
 *
 * Nada aqui sincroniza. O que sai de uma conferência para o resto do sistema
 * é movimentação {@code ajuste} comum, criada por
 * {@link MovementRepository#setAbsolute}, que já sobe pela outbox de sempre.
 */
public final class ConferenceRepository {

    private static final String TAG = "ConferenceRepository";

    public static final String STATUS_OPEN = "open";
    public static final String STATUS_FINISHED = "finished";
    public static final String STATUS_DISCARDED = "discarded";

    public static final String SCOPE_ALL = "all";
    public static final String SCOPE_CATEGORY = "category";
    public static final String SCOPE_LOCATION = "location";
    public static final String SCOPE_SUPPLIER = "supplier";

    /** Conferências por mês no plano gratuito. */
    public static final int FREE_MONTHLY_LIMIT = 3;

    private final SQLiteDatabase db;

    public ConferenceRepository(SQLiteDatabase db) {
        this.db = db;
    }

    // ---------------------------------------------------------------- sessão

    /** Uma conferência. */
    public static final class Session {
        public final String uuid;
        public final long startedAt;
        public final long finishedAt;
        public final String scopeType;
        public final String scopeValue;
        public final String status;

        Session(String uuid, long startedAt, long finishedAt,
                String scopeType, String scopeValue, String status) {
            this.uuid = uuid;
            this.startedAt = startedAt;
            this.finishedAt = finishedAt;
            this.scopeType = scopeType;
            this.scopeValue = scopeValue;
            this.status = status;
        }

        public boolean isOpen() {
            return STATUS_OPEN.equals(status);
        }
    }

    /**
     * Abre uma conferência. Não checa limite de plano: quem chama decide isso
     * antes, para que o aviso apareça **antes** de a pessoa contar qualquer
     * coisa, e nunca depois do trabalho feito.
     */
    public Session start(String scopeType, String scopeValue) {
        String uuid = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();

        ContentValues values = new ContentValues();
        values.put("uuid", uuid);
        values.put("started_at", now);
        values.put("scope_type", scopeType == null ? SCOPE_ALL : scopeType);
        values.put("scope_value", scopeValue);
        values.put("status", STATUS_OPEN);

        try {
            db.insertOrThrow(LocalDb.TABLE_CONFERENCES, null, values);
        } catch (Exception e) {
            Log.e(TAG, "falha ao abrir conferência", e);
            return null;
        }
        return new Session(uuid, now, 0L, scopeType, scopeValue, STATUS_OPEN);
    }

    /** A conferência em aberto, se houver. Só pode haver uma por vez. */
    public Session openSession() {
        Cursor cursor = null;
        try {
            cursor = db.query(LocalDb.TABLE_CONFERENCES,
                    null, "status=?", new String[]{STATUS_OPEN},
                    null, null, "started_at DESC", "1");
            return cursor.moveToFirst() ? readSession(cursor) : null;
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler conferência aberta", e);
            return null;
        } finally {
            close(cursor);
        }
    }

    public Session find(String sessionUuid) {
        if (sessionUuid == null) {
            return null;
        }
        Cursor cursor = null;
        try {
            cursor = db.query(LocalDb.TABLE_CONFERENCES,
                    null, "uuid=?", new String[]{sessionUuid}, null, null, null, "1");
            return cursor.moveToFirst() ? readSession(cursor) : null;
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler conferência", e);
            return null;
        } finally {
            close(cursor);
        }
    }

    /** Descarta a conferência aberta sem aplicar nada ao estoque. */
    public boolean discard(String sessionUuid) {
        if (sessionUuid == null) {
            return false;
        }
        ContentValues values = new ContentValues();
        values.put("status", STATUS_DISCARDED);
        values.put("finished_at", System.currentTimeMillis());
        try {
            return db.update(LocalDb.TABLE_CONFERENCES, values,
                    "uuid=?", new String[]{sessionUuid}) > 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao descartar conferência", e);
            return false;
        }
    }

    // --------------------------------------------------------------- limite

    /**
     * Conferências concluídas no mês civil corrente.
     *
     * Deliberadamente um {@code count} sobre a tabela, e não um contador
     * guardado à parte: um contador separado fica fora de sincronia com a
     * realidade na primeira falha, e aí o app cobra de quem não devia.
     */
    public int finishedThisMonth() {
        Calendar start = Calendar.getInstance();
        start.set(Calendar.DAY_OF_MONTH, 1);
        start.set(Calendar.HOUR_OF_DAY, 0);
        start.set(Calendar.MINUTE, 0);
        start.set(Calendar.SECOND, 0);
        start.set(Calendar.MILLISECOND, 0);

        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT count(*) FROM " + LocalDb.TABLE_CONFERENCES
                            + " WHERE status=? AND finished_at >= ?",
                    new String[]{STATUS_FINISHED, String.valueOf(start.getTimeInMillis())});
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao contar conferências do mês", e);
            return 0;
        } finally {
            close(cursor);
        }
    }

    /**
     * Quantas ainda cabem no mês para quem não assina.
     * {@link #FREE_MONTHLY_LIMIT} ou menos; nunca negativo.
     */
    public int freeRemainingThisMonth() {
        return Math.max(0, FREE_MONTHLY_LIMIT - finishedThisMonth());
    }

    // ------------------------------------------------------------- contagem

    /** Um item do escopo, com o que se espera e o que foi contado. */
    public static final class Item {
        public final String productUuid;
        public final String name;
        public final String unit;
        public final double expected;
        public final double cost;
        /** {@code null} enquanto não conferido — e não conferido não é zero. */
        public final Double counted;

        Item(String productUuid, String name, String unit,
             double expected, double cost, Double counted) {
            this.productUuid = productUuid;
            this.name = name;
            this.unit = unit;
            this.expected = expected;
            this.cost = cost;
            this.counted = counted;
        }

        public boolean isCounted() {
            return counted != null;
        }

        public double delta() {
            return counted == null ? 0d : counted - expected;
        }

        public boolean isDivergent() {
            return counted != null && delta() != 0d;
        }

        /** Diferença em dinheiro, pelo custo congelado na contagem. */
        public double deltaValue() {
            return delta() * cost;
        }
    }

    /**
     * Itens do escopo, já com o que foi contado nesta sessão.
     *
     * O custo vem de {@code cost} quando existe e cai para {@code value} (o
     * preço de venda) quando não: um total em reais aproximado comunica muito
     * mais que um total zerado, e a tela diz de onde veio o número.
     */
    public List<Item> itemsInScope(Session session) {
        List<Item> items = new ArrayList<>();
        if (session == null) {
            return items;
        }

        StringBuilder sql = new StringBuilder(
                "SELECT e.uuid, e.name, e.unit, e.amount, e.cost, e.value, c.counted, c.cost_at_count "
                        + "FROM " + LocalDb.TABLE_PRODUCTS + " e "
                        + "LEFT JOIN " + LocalDb.TABLE_CONFERENCE_COUNTS + " c "
                        + "  ON c.product_uuid = e.uuid AND c.session_uuid = ? "
                        + "WHERE e." + LocalDb.ACTIVE_PRODUCTS + " AND e.uuid IS NOT NULL");

        List<String> args = new ArrayList<>();
        args.add(session.uuid);

        String scope = session.scopeType == null ? SCOPE_ALL : session.scopeType;
        if (!SCOPE_ALL.equals(scope) && session.scopeValue != null) {
            // Só estas três colunas são aceitas como escopo; o valor sempre
            // viaja como argumento, nunca concatenado.
            String column = SCOPE_CATEGORY.equals(scope) ? "category"
                    : SCOPE_LOCATION.equals(scope) ? "location"
                    : SCOPE_SUPPLIER.equals(scope) ? "supplier" : null;
            if (column != null) {
                sql.append(" AND e.").append(column).append(" = ?");
                args.add(session.scopeValue);
            }
        }
        sql.append(" ORDER BY e.name COLLATE NOCASE");

        Cursor cursor = null;
        try {
            cursor = db.rawQuery(sql.toString(), args.toArray(new String[0]));
            while (cursor.moveToNext()) {
                Double counted = cursor.isNull(6) ? null : cursor.getDouble(6);
                double cost = cursor.isNull(7)
                        ? fallbackCost(cursor.getString(4), cursor.getString(5))
                        : cursor.getDouble(7);
                items.add(new Item(
                        cursor.getString(0),
                        cursor.getString(1),
                        cursor.getString(2),
                        Quantities.parse(cursor.getString(3)),
                        cost,
                        counted));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar itens do escopo", e);
        } finally {
            close(cursor);
        }
        return items;
    }

    private double fallbackCost(String cost, String value) {
        double c = Quantities.parse(cost, 0d);
        return c > 0d ? c : Quantities.parse(value, 0d);
    }

    /**
     * Acha um produto do escopo pelo código de barras ou SKU.
     *
     * Existe como consulta própria porque bipar é o gesto que mais se repete
     * numa contagem: varrer a lista inteira a cada bipe, e consultar o banco
     * por item, deixaria a tela lenta justamente onde ela precisa ser rápida.
     */
    public Item findByCode(Session session, String code) {
        if (session == null || code == null || code.trim().isEmpty()) {
            return null;
        }
        String trimmed = code.trim();

        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT e.uuid, e.name, e.unit, e.amount, e.cost, e.value, c.counted, c.cost_at_count "
                            + "FROM " + LocalDb.TABLE_PRODUCTS + " e "
                            + "LEFT JOIN " + LocalDb.TABLE_CONFERENCE_COUNTS + " c "
                            + "  ON c.product_uuid = e.uuid AND c.session_uuid = ? "
                            + "WHERE e." + LocalDb.ACTIVE_PRODUCTS + " AND e.uuid IS NOT NULL "
                            + "  AND (e.barcode = ? OR e.sku = ?) LIMIT 1",
                    new String[]{session.uuid, trimmed, trimmed});
            if (!cursor.moveToFirst()) {
                return null;
            }
            Double counted = cursor.isNull(6) ? null : cursor.getDouble(6);
            double cost = cursor.isNull(7)
                    ? fallbackCost(cursor.getString(4), cursor.getString(5))
                    : cursor.getDouble(7);
            Item item = new Item(cursor.getString(0), cursor.getString(1), cursor.getString(2),
                    Quantities.parse(cursor.getString(3)), cost, counted);
            // Fora do escopo escolhido não serve: contar o que não se está
            // conferindo confundiria o fechamento.
            return inScope(session, item.productUuid) ? item : null;
        } catch (Exception e) {
            Log.e(TAG, "falha ao buscar por código", e);
            return null;
        } finally {
            close(cursor);
        }
    }

    private boolean inScope(Session session, String productUuid) {
        String scope = session.scopeType == null ? SCOPE_ALL : session.scopeType;
        if (SCOPE_ALL.equals(scope) || session.scopeValue == null) {
            return true;
        }
        String column = SCOPE_CATEGORY.equals(scope) ? "category"
                : SCOPE_LOCATION.equals(scope) ? "location"
                : SCOPE_SUPPLIER.equals(scope) ? "supplier" : null;
        if (column == null) {
            return true;
        }
        Cursor cursor = null;
        try {
            cursor = db.query(LocalDb.TABLE_PRODUCTS, new String[]{"uuid"},
                    "uuid=? AND " + column + "=?",
                    new String[]{productUuid, session.scopeValue}, null, null, null, "1");
            return cursor.moveToFirst();
        } catch (Exception e) {
            Log.e(TAG, "falha ao conferir escopo", e);
            return false;
        } finally {
            close(cursor);
        }
    }

    /**
     * Registra a contagem de um item. Grava na hora, de propósito: contagem
     * longa interrompida não pode perder o que já foi contado.
     *
     * O esperado e o custo são lidos e congelados agora.
     */
    public boolean count(String sessionUuid, String productUuid, double counted) {
        if (sessionUuid == null || productUuid == null || counted < 0d) {
            return false;
        }

        Cursor cursor = null;
        try {
            cursor = db.query(LocalDb.TABLE_PRODUCTS,
                    new String[]{"amount", "cost", "value"},
                    "uuid=?", new String[]{productUuid}, null, null, null, "1");
            if (!cursor.moveToFirst()) {
                return false;
            }
            double expected = Quantities.parse(cursor.getString(0));
            double cost = fallbackCost(cursor.getString(1), cursor.getString(2));

            ContentValues values = new ContentValues();
            values.put("session_uuid", sessionUuid);
            values.put("product_uuid", productUuid);
            values.put("expected", expected);
            values.put("counted", counted);
            values.put("cost_at_count", cost);
            values.put("counted_at", System.currentTimeMillis());

            // Recontar o mesmo item substitui a contagem anterior: quem conta
            // de novo está corrigindo, não somando.
            return db.replace(LocalDb.TABLE_CONFERENCE_COUNTS, null, values) != -1L;
        } catch (Exception e) {
            Log.e(TAG, "falha ao registrar contagem", e);
            return false;
        } finally {
            close(cursor);
        }
    }

    /**
     * Quantos itens já foram contados nesta sessão.
     *
     * Consulta própria, e não {@code itemsInScope().size()}, porque o
     * contador é atualizado a cada item: refazer a junção com a tabela de
     * produtos a cada "Ok" deixaria a contagem lenta justamente no gesto que
     * mais se repete.
     */
    public int countedIn(Session session) {
        if (session == null) {
            return 0;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT count(*) FROM " + LocalDb.TABLE_CONFERENCE_COUNTS
                    + " WHERE session_uuid=?", new String[]{session.uuid});
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao contar itens conferidos", e);
            return 0;
        } finally {
            close(cursor);
        }
    }

    /** Desfaz a contagem de um item: ele volta a "não conferido". */
    public boolean clearCount(String sessionUuid, String productUuid) {
        try {
            return db.delete(LocalDb.TABLE_CONFERENCE_COUNTS,
                    "session_uuid=? AND product_uuid=?",
                    new String[]{sessionUuid, productUuid}) > 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao limpar contagem", e);
            return false;
        }
    }

    // ------------------------------------------------------------ resultado

    /** O que a tela de fechamento mostra. */
    public static final class Summary {
        public final int inScope;
        public final int counted;
        public final int divergent;
        /** Soma das diferenças negativas, em módulo (o que falta). */
        public final double missingValue;
        /** Soma das diferenças positivas (o que sobra). */
        public final double extraValue;
        public final List<Item> divergentItems;

        Summary(int inScope, int counted, int divergent,
                double missingValue, double extraValue, List<Item> divergentItems) {
            this.inScope = inScope;
            this.counted = counted;
            this.divergent = divergent;
            this.missingValue = missingValue;
            this.extraValue = extraValue;
            this.divergentItems = divergentItems;
        }

        /**
         * O cálculo do fechamento, puro e sem banco — é o que decide quanto
         * "falta em reais" e, principalmente, **quais produtos vão ter a
         * quantidade alterada**. Fica isolado para poder ser testado de
         * verdade: um erro aqui mexe no estoque real de alguém.
         *
         * Item sem contagem não entra em conta alguma e nunca vira zero.
         */
        public static Summary of(List<Item> items) {
            List<Item> divergent = new ArrayList<>();
            int counted = 0;
            double missing = 0d;
            double extra = 0d;

            for (Item item : items) {
                if (!item.isCounted()) {
                    continue;
                }
                counted++;
                if (!item.isDivergent()) {
                    continue;
                }
                divergent.add(item);
                double value = item.deltaValue();
                if (value < 0d) {
                    missing += -value;
                } else {
                    extra += value;
                }
            }
            return new Summary(items.size(), counted, divergent.size(), missing, extra, divergent);
        }

        /** Negativo quando falta mercadoria — que é o número que importa. */
        public double netValue() {
            return extraValue - missingValue;
        }

        public int notCounted() {
            return inScope - counted;
        }
    }

    public Summary summarize(Session session) {
        return Summary.of(itemsInScope(session));
    }

    /** Resultado de aplicar uma conferência ao estoque. */
    public static final class ApplyResult {
        public final boolean success;
        public final int applied;
        public final int failed;
        public final String message;

        ApplyResult(boolean success, int applied, int failed, String message) {
            this.success = success;
            this.applied = applied;
            this.failed = failed;
            this.message = message;
        }
    }

    /**
     * Fecha a conferência e lança um {@code ajuste} por item divergente.
     *
     * Itens não conferidos são ignorados — nunca zerados. Cada ajuste é uma
     * movimentação comum, cancelável pelo mecanismo compensatório que já
     * existe, e sobe pela outbox como qualquer outra.
     *
     * @param reasons motivo por produto ({@code product_uuid} → "quebra",
     *                "furto", "erro de lançamento", "achado"); pode ser nulo.
     */
    public ApplyResult finish(Session session, java.util.Map<String, String> reasons) {
        if (session == null || !session.isOpen()) {
            return new ApplyResult(false, 0, 0, "Nenhuma conferência aberta.");
        }

        MovementRepository movements = new MovementRepository(db);
        String stamp = dayStamp(session.startedAt);
        int applied = 0;
        int failed = 0;

        for (Item item : itemsInScope(session)) {
            if (!item.isDivergent()) {
                continue;
            }
            String reason = reasons == null ? null : reasons.get(item.productUuid);
            MovementRepository.Result result = movements.setAbsolute(
                    item.productUuid,
                    MovementRepository.AJUSTE,
                    item.counted,
                    note(stamp, item.delta(), reason));
            if (result.success) {
                applied++;
            } else {
                failed++;
                Log.w(TAG, "ajuste recusado em " + item.name + ": " + result.message);
            }
        }

        ContentValues values = new ContentValues();
        values.put("status", STATUS_FINISHED);
        values.put("finished_at", System.currentTimeMillis());
        try {
            db.update(LocalDb.TABLE_CONFERENCES, values,
                    "uuid=?", new String[]{session.uuid});
        } catch (Exception e) {
            Log.e(TAG, "falha ao fechar conferência", e);
        }

        return new ApplyResult(failed == 0, applied, failed,
                failed == 0 ? null : failed + " ajuste(s) não puderam ser aplicados.");
    }

    /** Ex.: {@code "conferência 15/11 · falta · quebra"}. */
    private String note(String stamp, double delta, String reason) {
        StringBuilder note = new StringBuilder("conferência ").append(stamp);
        note.append(delta < 0d ? " · falta" : " · sobra");
        if (reason != null && !reason.trim().isEmpty()) {
            note.append(" · ").append(reason.trim());
        }
        return note.toString();
    }

    private String dayStamp(long millis) {
        Calendar when = Calendar.getInstance();
        when.setTimeInMillis(millis);
        return String.format(Locale.getDefault(), "%02d/%02d",
                when.get(Calendar.DAY_OF_MONTH), when.get(Calendar.MONTH) + 1);
    }

    // --------------------------------------------------------------- escopos

    /** Valores distintos de uma coluna de escopo, para o seletor. */
    public List<String> scopeValues(String scopeType) {
        List<String> values = new ArrayList<>();
        String column = SCOPE_CATEGORY.equals(scopeType) ? "category"
                : SCOPE_LOCATION.equals(scopeType) ? "location"
                : SCOPE_SUPPLIER.equals(scopeType) ? "supplier" : null;
        if (column == null) {
            return values;
        }

        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT DISTINCT " + column + " FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE " + LocalDb.ACTIVE_PRODUCTS
                    + " AND " + column + " IS NOT NULL AND trim(" + column + ") <> ''"
                    + " ORDER BY " + column + " COLLATE NOCASE", null);
            while (cursor.moveToNext()) {
                values.add(cursor.getString(0));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar escopos", e);
        } finally {
            close(cursor);
        }
        return values;
    }

    // --------------------------------------------------------------- comuns

    private Session readSession(Cursor cursor) {
        return new Session(
                cursor.getString(cursor.getColumnIndexOrThrow("uuid")),
                cursor.getLong(cursor.getColumnIndexOrThrow("started_at")),
                cursor.isNull(cursor.getColumnIndexOrThrow("finished_at"))
                        ? 0L : cursor.getLong(cursor.getColumnIndexOrThrow("finished_at")),
                cursor.getString(cursor.getColumnIndexOrThrow("scope_type")),
                cursor.getString(cursor.getColumnIndexOrThrow("scope_value")),
                cursor.getString(cursor.getColumnIndexOrThrow("status")));
    }

    private void close(Cursor cursor) {
        if (cursor != null) {
            try {
                cursor.close();
            } catch (Exception ignored) {
                // fechar cursor nunca deve derrubar a operação
            }
        }
    }
}
