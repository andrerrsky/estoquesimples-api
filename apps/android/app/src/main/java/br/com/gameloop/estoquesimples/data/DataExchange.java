package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Importação e exportação alinhadas ao que a nuvem realmente guarda.
 *
 * Produto e movimentação são as únicas entidades de estoque no servidor.
 * Planilha cobre o cadastro (e, à parte, o histórico); o JSON leva os dois
 * juntos, com os mesmos nomes de campo do sync, para ir e voltar sem
 * tradução. Foto, fila de saída e cursor de sync ficam de fora: não existem
 * no contrato da API e copiá-los para outro aparelho só geraria lixo.
 */
public final class DataExchange {

    private static final String TAG = "DataExchange";

    public static final List<String> PRODUCT_CSV_HEADER = Arrays.asList(
            "nome", "descricao", "quantidade", "valor", "categoria", "sku",
            "codigo_barras", "fornecedor", "localizacao", "estoque_minimo", "unidade",
            // No fim, para planilhas antigas (sem a coluna) continuarem iguais.
            "custo"
    );

    public static final List<String> MOVEMENT_CSV_HEADER = Arrays.asList(
            "id", "product_id", "product_name", "change_type", "quantity",
            "occurred_at", "note"
    );

    private static final int MAX_NAME = 200;
    private static final int MAX_DESCRIPTION = 2000;
    private static final int MAX_SHORT = 120;
    private static final int MAX_CODE = 80;
    private static final int MAX_UNIT = 30;
    private static final int MAX_LOG_LINES = 80;

    private final SQLiteDatabase db;
    private final ProductRepository products;
    private final MovementRepository movements;
    /**
     * Trava pega a cada linha importada, e não durante o arquivo inteiro.
     *
     * A tela principal lê o banco sob a mesma trava na thread de interface;
     * segurá-la durante uma planilha de milhares de linhas congelava o app
     * ("não está respondendo", ANR na versão 29). Linha a linha, a interface
     * consegue entrar entre uma gravação e outra. Cada linha já é atômica (o
     * repositório grava produto, movimentação e fila na mesma transação).
     */
    private final Object rowLock;

    public DataExchange(SQLiteDatabase db) {
        this(db, new Object());
    }

    public DataExchange(SQLiteDatabase db, Object rowLock) {
        this.db = db;
        this.products = new ProductRepository(db);
        this.movements = new MovementRepository(db);
        this.rowLock = rowLock == null ? new Object() : rowLock;
    }

    /** Contagem e recado para a tela, sem dados demais. */
    public static final class Report {
        public int created;
        public int updated;
        public int skipped;
        public int failed;
        public int movementsImported;
        public int exported;
        /** Só no backup JSON: produtos gravados (o resto de {@code exported} são movimentações). */
        public int productsExported = -1;
        /**
         * Por que o arquivo inteiro não pôde ser lido ({@code null} = foi lido).
         *
         * Vai para a telemetria: até a versão 33 a importação que falhava não
         * deixava rastro nenhum — nem evento, nem registro —, então não havia
         * como saber se ninguém importa ou se a importação não funciona.
         */
        public String failureCode;
        public final List<String> lines = new ArrayList<>();

        void line(String text) {
            if (lines.size() < MAX_LOG_LINES) {
                lines.add(text);
            }
        }

        public String asLog() {
            StringBuilder out = new StringBuilder();
            for (String line : lines) {
                out.append(line).append('\n');
            }
            if (created + updated + skipped + failed + movementsImported > 0) {
                out.append('\n')
                        .append(br.com.gameloop.estoquesimples.Texto.plural(created, "criado", "criados")).append(", ")
                        .append(br.com.gameloop.estoquesimples.Texto.plural(updated, "atualizado", "atualizados")).append(", ")
                        .append(br.com.gameloop.estoquesimples.Texto.plural(skipped, "ignorado", "ignorados"));
                if (movementsImported > 0) {
                    out.append(", ").append(movementsImported).append(" movimentação(ões)");
                }
                if (failed > 0) {
                    out.append(", ").append(failed).append(" com erro");
                }
                out.append('.');
            }
            return out.toString();
        }
    }

    // -------------------------------------------------------------------------
    // Exportação
    // -------------------------------------------------------------------------

    public Report exportProductsCsv(OutputStream out) throws IOException {
        Report report = new Report();
        StringBuilder csv = new StringBuilder();
        csv.append(CsvCodec.BOM_UTF8);
        csv.append(CsvCodec.join(PRODUCT_CSV_HEADER)).append('\n');

        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT name, description, amount, value, category, sku, barcode, "
                            + "supplier, location, min_stock, unit, cost FROM "
                            + LocalDb.TABLE_PRODUCTS + " WHERE " + LocalDb.ACTIVE_PRODUCTS
                            + " ORDER BY name COLLATE NOCASE",
                    null);
            while (cursor.moveToNext()) {
                csv.append(CsvCodec.join(Arrays.asList(
                        text(cursor, 0),
                        text(cursor, 1),
                        text(cursor, 2, "0"),
                        text(cursor, 3, "0"),
                        text(cursor, 4),
                        text(cursor, 5),
                        text(cursor, 6),
                        text(cursor, 7),
                        text(cursor, 8),
                        text(cursor, 9),
                        text(cursor, 10),
                        text(cursor, 11)
                ))).append('\n');
                report.exported++;
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }

        out.write(csv.toString().getBytes(StandardCharsets.UTF_8));
        out.flush();
        return report;
    }

    public Report exportMovementsCsv(OutputStream out) throws IOException {
        Report report = new Report();
        StringBuilder csv = new StringBuilder();
        csv.append(CsvCodec.BOM_UTF8);
        csv.append(CsvCodec.join(MOVEMENT_CSV_HEADER)).append('\n');

        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT uuid, product_uuid, product_name, change_type, quantity, "
                            + "timestamp, note FROM " + LocalDb.TABLE_MOVEMENTS
                            + " WHERE deleted_at IS NULL ORDER BY timestamp, id",
                    null);
            while (cursor.moveToNext()) {
                String type = text(cursor, 3);
                double stored = cursor.isNull(4) ? 0d : cursor.getDouble(4);
                csv.append(CsvCodec.join(Arrays.asList(
                        text(cursor, 0),
                        text(cursor, 1),
                        text(cursor, 2),
                        type,
                        Double.toString(MovementRepository.signedQuantity(type, stored)),
                        Long.toString(cursor.isNull(5) ? 0L : cursor.getLong(5)),
                        text(cursor, 6)
                ))).append('\n');
                report.exported++;
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }

        out.write(csv.toString().getBytes(StandardCharsets.UTF_8));
        out.flush();
        return report;
    }

    public Report exportJson(OutputStream out) throws Exception {
        Report report = new Report();
        JSONObject backup = new JSONObject();
        backup.put("format", PortableBackup.FORMAT);
        backup.put("version", PortableBackup.VERSION);
        backup.put("exportedAt", System.currentTimeMillis());
        backup.put("source", "device");

        JSONArray productArray = new JSONArray();
        Cursor productCursor = null;
        try {
            productCursor = db.rawQuery(
                    "SELECT * FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS + " ORDER BY id",
                    null);
            while (productCursor.moveToNext()) {
                Product product = Product.from(productCursor);
                if (product.uuid == null || product.uuid.isEmpty()) {
                    continue;
                }
                productArray.put(PortableBackup.product(product));
                report.exported++;
            }
        } finally {
            LocalDb.closeQuietly(productCursor);
        }
        backup.put("products", productArray);
        report.productsExported = report.exported;

        JSONArray movementArray = new JSONArray();
        Cursor movementCursor = null;
        try {
            movementCursor = db.rawQuery(
                    "SELECT uuid, product_uuid, product_name, change_type, quantity, "
                            + "timestamp, note FROM " + LocalDb.TABLE_MOVEMENTS
                            + " WHERE deleted_at IS NULL ORDER BY timestamp, id",
                    null);
            while (movementCursor.moveToNext()) {
                report.exported++;
                movementArray.put(PortableBackup.movement(
                        text(movementCursor, 0),
                        emptyToNull(text(movementCursor, 1)),
                        emptyToNull(text(movementCursor, 2)),
                        text(movementCursor, 3),
                        movementCursor.isNull(4) ? 0d : movementCursor.getDouble(4),
                        movementCursor.isNull(5) ? 0L : movementCursor.getLong(5),
                        emptyToNull(text(movementCursor, 6))
                ));
            }
        } finally {
            LocalDb.closeQuietly(movementCursor);
        }
        backup.put("movements", movementArray);

        out.write(backup.toString(2).getBytes(StandardCharsets.UTF_8));
        out.flush();
        return report;
    }

    // -------------------------------------------------------------------------
    // Importação
    // -------------------------------------------------------------------------

    public Report importCsv(Reader reader) throws IOException {
        Report report = new Report();
        List<List<String>> rows = CsvCodec.parse(reader);
        if (rows.isEmpty()) {
            report.failureCode = "arquivo_vazio";
            report.line("Arquivo vazio.");
            return report;
        }

        /*
         * Sem cabeçalho reconhecido, recusamos em vez de adivinhar.
         *
         * O caminho antigo lia a planilha por posição: a 1ª coluna era o
         * nome, a 3ª a quantidade, a 4ª o valor. Numa lista de preços
         * ("Descrição;Preço") isso fazia o preço virar quantidade e zerava o
         * resto — com movimentação de ajuste, que é imutável. Mais vale uma
         * recusa com instrução do que um estoque destruído em silêncio.
         */
        if (!CsvCodec.looksLikeHeader(rows.get(0))) {
            report.failureCode = "sem_cabecalho";
            report.failed++;
            report.line("Não foi possível entender a planilha: a primeira linha precisa ser o "
                    + "cabeçalho com os nomes das colunas (nome, quantidade, valor...).");
            report.line("Exporte seus produtos aqui mesmo para ver um arquivo de exemplo com as "
                    + "colunas certas, preencha nele e importe de volta.");
            return report;
        }

        Map<String, Integer> columns = indexHeader(rows.get(0));
        int start = 1;
        if (columns.containsKey("change_type") || columns.containsKey("changetype")) {
            return importMovementRows(rows, start, columns, report);
        }

        for (int i = start; i < rows.size(); i++) {
            try {
                RowProduct row = RowProduct.mapped(rows.get(i), columns);
                synchronized (rowLock) {
                    applyProductRow(row, report, false);
                }
            } catch (Exception e) {
                report.failed++;
                report.line("✗ Linha " + (i + 1) + ": " + e.getMessage());
                Log.w(TAG, "falha ao importar linha CSV", e);
            }
        }
        return report;
    }

    public Report importJson(JSONObject json) {
        Report report = new Report();
        if (!PortableBackup.isBackup(json)) {
            report.failureCode = "json_estranho";
            report.failed++;
            report.line("Arquivo JSON não é uma cópia do Estoque Simples.");
            return report;
        }

        JSONArray productArray = PortableBackup.productsOf(json);
        JSONArray movementArray = PortableBackup.movementsOf(json);
        boolean hasLedger = movementArray.length() > 0;
        Map<String, String> uuidRemap = new HashMap<>();

        for (int i = 0; i < productArray.length(); i++) {
            JSONObject item = productArray.optJSONObject(i);
            if (item == null) {
                report.skipped++;
                continue;
            }
            if (item.has("deletedAt") && !item.isNull("deletedAt") && item.optLong("deletedAt") > 0) {
                report.skipped++;
                continue;
            }
            try {
                RowProduct row = RowProduct.fromJson(item);
                String remoteId = row.id;
                String localUuid;
                synchronized (rowLock) {
                    localUuid = applyProductRow(row, report, hasLedger);
                }
                if (localUuid != null && remoteId != null) {
                    uuidRemap.put(remoteId, localUuid);
                }
            } catch (Exception e) {
                report.failed++;
                report.line("✗ Produto: " + e.getMessage());
                Log.w(TAG, "falha ao importar produto JSON", e);
            }
        }

        for (int i = 0; i < movementArray.length(); i++) {
            JSONObject item = movementArray.optJSONObject(i);
            if (item == null) {
                continue;
            }
            try {
                String remoteProduct = emptyToNull(item.optString("productId", null));
                String localProduct = remoteProduct == null
                        ? null
                        : uuidRemap.getOrDefault(remoteProduct, remoteProduct);
                MovementRepository.Result result;
                synchronized (rowLock) {
                    result = movements.importLedgerEvent(
                            emptyToNull(item.optString("id", null)),
                            localProduct,
                            emptyToNull(item.optString("productName", null)),
                            item.optString("changeType", MovementRepository.AJUSTE),
                            item.optDouble("quantity", 0d),
                            emptyToNull(item.optString("note", null)),
                            item.optLong("occurredAt", System.currentTimeMillis())
                    );
                }
                if (result.success) {
                    report.movementsImported++;
                } else {
                    report.failed++;
                    report.line("✗ Movimentação: " + result.message);
                }
            } catch (Exception e) {
                report.failed++;
                report.line("✗ Movimentação: " + e.getMessage());
                Log.w(TAG, "falha ao importar movimentação JSON", e);
            }
        }
        return report;
    }

    private Report importMovementRows(List<List<String>> rows, int start,
                                      Map<String, Integer> columns, Report report) {
        for (int i = start; i < rows.size(); i++) {
            List<String> fields = rows.get(i);
            try {
                String id = cell(fields, columns, "id");
                String productId = cell(fields, columns, "product_id", "productid");
                String productName = cell(fields, columns, "product_name", "productname", "nome");
                String type = cell(fields, columns, "change_type", "changetype", "tipo");
                double quantity = Quantities.parse(cell(fields, columns, "quantity", "quantidade"), 0d);
                long occurredAt = parseLong(cell(fields, columns, "occurred_at", "occurredat", "timestamp"));
                String note = cell(fields, columns, "note", "obs", "observacao");
                MovementRepository.Result result;
                synchronized (rowLock) {
                    result = movements.importLedgerEvent(
                            emptyToNull(id), emptyToNull(productId), emptyToNull(productName),
                            type, quantity, emptyToNull(note), occurredAt);
                }
                if (result.success) {
                    report.movementsImported++;
                } else {
                    report.failed++;
                    report.line("✗ Linha " + (i + 1) + ": " + result.message);
                }
            } catch (Exception e) {
                report.failed++;
                report.line("✗ Linha " + (i + 1) + ": " + e.getMessage());
            }
        }
        return report;
    }

    /**
     * @param historicoNoArquivo o arquivo traz as movimentações (backup JSON),
     *        e então a quantidade nasce delas: o saldo inicial não pode nascer
     *        de novo como {@code importacao}, nem a atualização lançar ajuste.
     */
    private String applyProductRow(RowProduct row, Report report, boolean historicoNoArquivo) {
        if (row.name.isEmpty()) {
            report.skipped++;
            report.line("✗ Linha sem nome, ignorada.");
            return null;
        }

        String existing = resolveExisting(row);
        if (existing != null) {
            return updateExisting(existing, row, report, historicoNoArquivo);
        }

        ContentValues values = row.toValues();
        String changeType = historicoNoArquivo ? MovementRepository.CADASTRO : MovementRepository.IMPORTACAO;
        if (historicoNoArquivo) {
            values.put("amount", Quantities.forStorage(0d));
        }
        String uuid = products.create(values, changeType);
        if (uuid == null) {
            report.failed++;
            report.line("✗ " + row.name + " não pôde ser gravado.");
            return null;
        }
        report.created++;
        report.line("✓ " + row.name + " cadastrado.");
        return uuid;
    }

    private String resolveExisting(RowProduct row) {
        if (row.id != null && products.existsByUuid(row.id)) {
            Product current = products.findByUuid(row.id);
            if (current != null && !current.isDeleted()) {
                return row.id;
            }
            // O uuid ainda está ocupado por uma lápide. Gerar outro na criação
            // evita colidir no índice único; o remap liga o id do arquivo ao novo.
            row.id = null;
        }
        String bySku = products.findUuidBySku(row.sku);
        if (bySku != null) {
            return bySku;
        }
        String byBarcode = products.findUuidByBarcode(row.barcode);
        if (byBarcode != null) {
            return byBarcode;
        }
        return products.findUuidByName(row.name);
    }

    /**
     * Atualiza o que o arquivo informou, e só isso.
     *
     * A decisão de cada campo está em {@link ProductMerge} (classe pura,
     * testada): campo que o arquivo não trouxe não é tocado. Antes, tudo era
     * gravado, e uma planilha parcial apagava os outros doze campos do
     * produto que ela casava.
     *
     * @param manterQuantidadeExistente o histórico vem no arquivo, então o
     *        ajuste de quantidade aqui duplicaria o que as movimentações
     *        importadas já explicam.
     */
    private String updateExisting(String uuid, RowProduct row, Report report,
                                  boolean manterQuantidadeExistente) {
        Product current = products.findByUuid(uuid);
        if (current == null) {
            report.failed++;
            return uuid;
        }

        ProductMerge.Resultado merge = ProductMerge.merge(
                ProductMerge.Atual.de(current), row.entrada(), manterQuantidadeExistente);

        if (merge.semMudanca()) {
            report.skipped++;
            report.line("· " + row.name + " já estava igual.");
            return uuid;
        }

        ContentValues values = new ContentValues();
        for (Map.Entry<String, String> campo : merge.colunas.entrySet()) {
            values.put(campo.getKey(), campo.getValue());
        }

        if (values.size() > 0) {
            if (values.containsKey("name") && products.nameTakenByOther(row.name, uuid)) {
                values.remove("name");
            }
            if (values.size() > 0 && !products.update(uuid, values)) {
                report.failed++;
                report.line("✗ " + row.name + " não pôde ser atualizado.");
                return uuid;
            }
        }

        if (merge.quantidadeMudou) {
            MovementRepository.Result result = movements.setAbsolute(
                    uuid, MovementRepository.AJUSTE, merge.quantidade, "Importação");
            if (!result.success) {
                report.failed++;
                report.line("✗ " + row.name + ": " + result.message);
                return uuid;
            }
        }

        report.updated++;
        report.line("✓ " + row.name + " atualizado.");
        return uuid;
    }

    private static Map<String, Integer> indexHeader(List<String> header) {
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < header.size(); i++) {
            index.put(CsvCodec.normalizeHeader(header.get(i)), i);
        }
        return index;
    }

    private static String cell(List<String> fields, Map<String, Integer> columns, String... keys) {
        for (String key : keys) {
            Integer at = columns.get(key);
            if (at != null && at < fields.size()) {
                String value = fields.get(at);
                if (value != null && !value.isEmpty()) {
                    return value;
                }
            }
        }
        return "";
    }

    private static String text(Cursor cursor, int index) {
        return text(cursor, index, "");
    }

    private static String text(Cursor cursor, int index, String fallback) {
        if (cursor.isNull(index)) {
            return fallback;
        }
        String value = cursor.getString(index);
        return value == null ? fallback : value;
    }

    private static String emptyToNull(String value) {
        if (value == null || value.trim().isEmpty() || "null".equalsIgnoreCase(value)) {
            return null;
        }
        return value.trim();
    }

    private static long parseLong(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return System.currentTimeMillis();
        }
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            return System.currentTimeMillis();
        }
    }

    /**
     * Uma linha de produto, já limitada ao tamanho que a API aceita, com a
     * marca de <b>quais campos o arquivo realmente informou</b>.
     *
     * A presença é decidida aqui porque depende do formato:
     * <ul>
     *   <li><b>planilha</b>: a coluna existe e a célula tem conteúdo. Célula
     *       vazia não apaga o que está cadastrado — quem importa a lista de
     *       preços do fornecedor não quer limpar o resto do produto;</li>
     *   <li><b>backup JSON</b>: a chave existe e não é nula, e aí o vazio
     *       apaga de propósito — restaurar uma cópia precisa devolver o
     *       produto exatamente como ele estava, inclusive nos campos que o
     *       dono tinha limpado.</li>
     * </ul>
     */
    static final class RowProduct {
        String id;
        String name = "";
        String description = "";
        double quantity;
        double unitValue;
        /** Preço de custo; {@code null} = a linha não informa. */
        Double unitCost;
        String category = "";
        String sku = "";
        String barcode = "";
        String supplier = "";
        String location = "";
        double minStock;
        String unit = "";

        private final EnumSet<ProductMerge.Campo> informados =
                EnumSet.noneOf(ProductMerge.Campo.class);

        static RowProduct mapped(List<String> fields, Map<String, Integer> columns) {
            RowProduct row = new RowProduct();
            row.id = emptyToNull(clip(cell(fields, columns, "id", "uuid"), 36));
            row.name = row.texto(ProductMerge.Campo.NOME,
                    cell(fields, columns, "nome", "name", "produto"), MAX_NAME);
            row.description = row.texto(ProductMerge.Campo.DESCRICAO,
                    cell(fields, columns, "descricao", "description"), MAX_DESCRIPTION);
            row.quantity = row.numero(ProductMerge.Campo.QUANTIDADE,
                    cell(fields, columns, "quantidade", "quantity", "qtd", "estoque"));
            row.unitValue = row.numero(ProductMerge.Campo.VALOR,
                    cell(fields, columns, "valor", "preco", "unitvalue", "unit_value"));
            row.unitCost = Product.costOf(cell(fields, columns, "custo", "preco_de_custo",
                    "custo_unitario", "unitcost", "unit_cost", "cost"));
            if (row.unitCost != null) {
                row.informados.add(ProductMerge.Campo.CUSTO);
            }
            row.category = row.texto(ProductMerge.Campo.CATEGORIA,
                    cell(fields, columns, "categoria", "category"), MAX_SHORT);
            row.sku = row.texto(ProductMerge.Campo.SKU, cell(fields, columns, "sku"), MAX_CODE);
            row.barcode = row.texto(ProductMerge.Campo.CODIGO_BARRAS,
                    cell(fields, columns, "codigo_barras", "codigo_de_barras", "barcode", "ean"),
                    MAX_CODE);
            row.supplier = row.texto(ProductMerge.Campo.FORNECEDOR,
                    cell(fields, columns, "fornecedor", "supplier"), MAX_SHORT);
            row.location = row.texto(ProductMerge.Campo.LOCALIZACAO,
                    cell(fields, columns, "localizacao", "location"), MAX_SHORT);
            row.minStock = row.numero(ProductMerge.Campo.ESTOQUE_MINIMO,
                    cell(fields, columns, "estoque_minimo", "min_stock", "minstock"));
            row.unit = row.texto(ProductMerge.Campo.UNIDADE,
                    cell(fields, columns, "unidade", "unit"), MAX_UNIT);
            return row;
        }

        static RowProduct fromJson(JSONObject json) {
            RowProduct row = new RowProduct();
            row.id = emptyToNull(json.optString("id", null));
            row.name = row.jsonTexto(json, "name", ProductMerge.Campo.NOME, MAX_NAME);
            row.description = row.jsonTexto(json, "description", ProductMerge.Campo.DESCRICAO,
                    MAX_DESCRIPTION);
            row.quantity = row.jsonNumero(json, "quantity", ProductMerge.Campo.QUANTIDADE);
            row.unitValue = row.jsonNumero(json, "unitValue", ProductMerge.Campo.VALOR);
            row.unitCost = informado(json, "unitCost") ? json.optDouble("unitCost", 0d) : null;
            if (row.unitCost != null) {
                row.informados.add(ProductMerge.Campo.CUSTO);
            }
            row.category = row.jsonTexto(json, "category", ProductMerge.Campo.CATEGORIA, MAX_SHORT);
            row.sku = row.jsonTexto(json, "sku", ProductMerge.Campo.SKU, MAX_CODE);
            row.barcode = row.jsonTexto(json, "barcode", ProductMerge.Campo.CODIGO_BARRAS, MAX_CODE);
            row.supplier = row.jsonTexto(json, "supplier", ProductMerge.Campo.FORNECEDOR, MAX_SHORT);
            row.location = row.jsonTexto(json, "location", ProductMerge.Campo.LOCALIZACAO, MAX_SHORT);
            row.minStock = row.jsonNumero(json, "minStock", ProductMerge.Campo.ESTOQUE_MINIMO);
            row.unit = row.jsonTexto(json, "unit", ProductMerge.Campo.UNIDADE, MAX_UNIT);
            return row;
        }

        /** O que esta linha autoriza a mudar num produto que já existe. */
        ProductMerge.Entrada entrada() {
            ProductMerge.Entrada entrada = new ProductMerge.Entrada();
            entrada.nome = name;
            entrada.descricao = description;
            entrada.quantidade = quantity;
            entrada.valor = unitValue;
            entrada.custo = unitCost;
            entrada.categoria = category;
            entrada.sku = sku;
            entrada.codigoBarras = barcode;
            entrada.fornecedor = supplier;
            entrada.localizacao = location;
            entrada.estoqueMinimo = minStock;
            entrada.unidade = unit;
            for (ProductMerge.Campo campo : informados) {
                entrada.informa(campo);
            }
            return entrada;
        }

        private String texto(ProductMerge.Campo campo, String raw, int max) {
            if (raw != null && !raw.trim().isEmpty()) {
                informados.add(campo);
            }
            return clip(raw, max);
        }

        private double numero(ProductMerge.Campo campo, String raw) {
            if (raw != null && !raw.trim().isEmpty()) {
                informados.add(campo);
            }
            return Quantities.parse(raw, 0d);
        }

        private String jsonTexto(JSONObject json, String key, ProductMerge.Campo campo, int max) {
            if (informado(json, key)) {
                informados.add(campo);
            }
            return clip(json.optString(key, ""), max);
        }

        private double jsonNumero(JSONObject json, String key, ProductMerge.Campo campo) {
            if (informado(json, key)) {
                informados.add(campo);
            }
            return json.optDouble(key, 0d);
        }

        private static boolean informado(JSONObject json, String key) {
            return json.has(key) && !json.isNull(key);
        }

        ContentValues toValues() {
            ContentValues values = new ContentValues();
            if (id != null && ProductRepository.isUuid(id)) {
                values.put("uuid", id);
            }
            values.put("name", name);
            values.put("description", description);
            values.put("amount", Quantities.forStorage(quantity));
            values.put("value", Quantities.forStorage(unitValue));
            if (unitCost != null) {
                values.put("cost", Quantities.forStorage(unitCost));
            }
            values.put("photo", "");
            values.put("category", category);
            values.put("sku", sku);
            values.put("barcode", barcode);
            values.put("supplier", supplier);
            values.put("location", location);
            values.put("min_stock", Quantities.forStorage(minStock));
            values.put("unit", unit);
            return values;
        }

        private static String clip(String value, int max) {
            return PortableBackup.clip(value, max);
        }
    }
}
