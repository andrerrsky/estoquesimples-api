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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

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
            "codigo_barras", "fornecedor", "localizacao", "estoque_minimo", "unidade"
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

    public DataExchange(SQLiteDatabase db) {
        this.db = db;
        this.products = new ProductRepository(db);
        this.movements = new MovementRepository(db);
    }

    /** Contagem e recado para a tela, sem dados demais. */
    public static final class Report {
        public int created;
        public int updated;
        public int skipped;
        public int failed;
        public int movementsImported;
        public int exported;
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
                        .append(created).append(" criado(s), ")
                        .append(updated).append(" atualizado(s), ")
                        .append(skipped).append(" ignorado(s)");
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
                            + "supplier, location, min_stock, unit FROM "
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
                        text(cursor, 10)
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

        JSONArray movementArray = new JSONArray();
        Cursor movementCursor = null;
        try {
            movementCursor = db.rawQuery(
                    "SELECT uuid, product_uuid, product_name, change_type, quantity, "
                            + "timestamp, note FROM " + LocalDb.TABLE_MOVEMENTS
                            + " WHERE deleted_at IS NULL ORDER BY timestamp, id",
                    null);
            while (movementCursor.moveToNext()) {
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
            report.line("Arquivo vazio.");
            return report;
        }

        Map<String, Integer> columns = null;
        int start = 0;
        if (CsvCodec.looksLikeHeader(rows.get(0))) {
            columns = indexHeader(rows.get(0));
            start = 1;
            if (columns.containsKey("change_type") || columns.containsKey("changetype")) {
                return importMovementRows(rows, start, columns, report);
            }
        }

        for (int i = start; i < rows.size(); i++) {
            try {
                RowProduct row = columns == null
                        ? RowProduct.positional(rows.get(i))
                        : RowProduct.mapped(rows.get(i), columns);
                applyProductRow(row, report, false);
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
                String localUuid = applyProductRow(row, report, hasLedger);
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
                MovementRepository.Result result = movements.importLedgerEvent(
                        emptyToNull(item.optString("id", null)),
                        localProduct,
                        emptyToNull(item.optString("productName", null)),
                        item.optString("changeType", MovementRepository.AJUSTE),
                        item.optDouble("quantity", 0d),
                        emptyToNull(item.optString("note", null)),
                        item.optLong("occurredAt", System.currentTimeMillis())
                );
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
                MovementRepository.Result result = movements.importLedgerEvent(
                        emptyToNull(id), emptyToNull(productId), emptyToNull(productName),
                        type, quantity, emptyToNull(note), occurredAt);
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
     * @param skipInitialMovement quando o JSON já traz o histórico, o saldo
     *        inicial não pode nascer de novo como {@code importacao} — as
     *        movimentações do arquivo é que explicam a quantidade.
     */
    private String applyProductRow(RowProduct row, Report report, boolean skipInitialMovement) {
        if (row.name.isEmpty()) {
            report.skipped++;
            report.line("✗ Linha sem nome, ignorada.");
            return null;
        }

        String existing = resolveExisting(row);
        if (existing != null) {
            return updateExisting(existing, row, report, skipInitialMovement);
        }

        ContentValues values = row.toValues();
        String changeType = skipInitialMovement ? MovementRepository.CADASTRO : MovementRepository.IMPORTACAO;
        if (skipInitialMovement) {
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

    private String updateExisting(String uuid, RowProduct row, Report report,
                                  boolean skipQuantity) {
        Product current = products.findByUuid(uuid);
        if (current == null) {
            report.failed++;
            return uuid;
        }

        ContentValues values = new ContentValues();
        putIfChanged(values, "name", current.name, row.name);
        putIfChanged(values, "description", current.description, row.description);
        putIfChanged(values, "value", current.value, Quantities.forStorage(row.unitValue));
        putIfChanged(values, "category", current.category, row.category);
        putIfChanged(values, "sku", current.sku, row.sku);
        putIfChanged(values, "barcode", current.barcode, row.barcode);
        putIfChanged(values, "supplier", current.supplier, row.supplier);
        putIfChanged(values, "location", current.location, row.location);
        putIfChanged(values, "min_stock", current.minStock, Quantities.forStorage(row.minStock));
        putIfChanged(values, "unit", current.unit, row.unit);

        boolean qtyChanged = !skipQuantity
                && Double.compare(current.amountAsNumber(), row.quantity) != 0;

        if (values.size() == 0 && !qtyChanged) {
            report.skipped++;
            report.line("· " + row.name + " já estava igual.");
            return uuid;
        }

        if (values.size() > 0) {
            if (products.nameTakenByOther(row.name, uuid)) {
                values.remove("name");
            }
            if (values.size() > 0 && !products.update(uuid, values)) {
                report.failed++;
                report.line("✗ " + row.name + " não pôde ser atualizado.");
                return uuid;
            }
        }

        if (qtyChanged) {
            MovementRepository.Result result = movements.setAbsolute(
                    uuid, MovementRepository.AJUSTE, row.quantity, "Importação");
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

    private static void putIfChanged(ContentValues values, String column, String current, String next) {
        String left = current == null ? "" : current.trim();
        String right = next == null ? "" : next.trim();
        if (!Objects.equals(left, right)) {
            values.put(column, right);
        }
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

    /** Uma linha de produto, já limitada ao tamanho que a API aceita. */
    static final class RowProduct {
        String id;
        String name = "";
        String description = "";
        double quantity;
        double unitValue;
        String category = "";
        String sku = "";
        String barcode = "";
        String supplier = "";
        String location = "";
        double minStock;
        String unit = "";

        static RowProduct positional(List<String> fields) {
            RowProduct row = new RowProduct();
            row.name = clip(at(fields, 0), MAX_NAME);
            row.description = clip(at(fields, 1), MAX_DESCRIPTION);
            row.quantity = Quantities.parse(at(fields, 2), 0d);
            row.unitValue = Quantities.parse(at(fields, 3), 0d);
            row.category = clip(at(fields, 5), MAX_SHORT);
            row.sku = clip(at(fields, 6), MAX_CODE);
            row.barcode = clip(at(fields, 7), MAX_CODE);
            row.supplier = clip(at(fields, 8), MAX_SHORT);
            row.location = clip(at(fields, 9), MAX_SHORT);
            row.minStock = Quantities.parse(at(fields, 10), 0d);
            row.unit = clip(at(fields, 11), MAX_UNIT);
            return row;
        }

        static RowProduct mapped(List<String> fields, Map<String, Integer> columns) {
            RowProduct row = new RowProduct();
            row.id = emptyToNull(clip(cell(fields, columns, "id", "uuid"), 36));
            row.name = clip(cell(fields, columns, "nome", "name", "produto"), MAX_NAME);
            row.description = clip(cell(fields, columns, "descricao", "description"), MAX_DESCRIPTION);
            row.quantity = Quantities.parse(cell(fields, columns, "quantidade", "quantity", "qtd", "estoque"), 0d);
            row.unitValue = Quantities.parse(cell(fields, columns, "valor", "preco", "unitvalue", "unit_value"), 0d);
            row.category = clip(cell(fields, columns, "categoria", "category"), MAX_SHORT);
            row.sku = clip(cell(fields, columns, "sku"), MAX_CODE);
            row.barcode = clip(cell(fields, columns, "codigo_barras", "codigo_de_barras", "barcode", "ean"), MAX_CODE);
            row.supplier = clip(cell(fields, columns, "fornecedor", "supplier"), MAX_SHORT);
            row.location = clip(cell(fields, columns, "localizacao", "location"), MAX_SHORT);
            row.minStock = Quantities.parse(cell(fields, columns, "estoque_minimo", "min_stock", "minstock"), 0d);
            row.unit = clip(cell(fields, columns, "unidade", "unit"), MAX_UNIT);
            return row;
        }

        static RowProduct fromJson(JSONObject json) {
            RowProduct row = new RowProduct();
            row.id = emptyToNull(json.optString("id", null));
            row.name = clip(json.optString("name", ""), MAX_NAME);
            row.description = clip(json.optString("description", ""), MAX_DESCRIPTION);
            row.quantity = json.optDouble("quantity", 0d);
            row.unitValue = json.optDouble("unitValue", 0d);
            row.category = clip(json.optString("category", ""), MAX_SHORT);
            row.sku = clip(json.optString("sku", ""), MAX_CODE);
            row.barcode = clip(json.optString("barcode", ""), MAX_CODE);
            row.supplier = clip(json.optString("supplier", ""), MAX_SHORT);
            row.location = clip(json.optString("location", ""), MAX_SHORT);
            row.minStock = json.optDouble("minStock", 0d);
            row.unit = clip(json.optString("unit", ""), MAX_UNIT);
            return row;
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

        private static String at(List<String> fields, int index) {
            if (fields == null || index >= fields.size() || fields.get(index) == null) {
                return "";
            }
            String value = fields.get(index).trim();
            return "null".equalsIgnoreCase(value) ? "" : value;
        }

        private static String clip(String value, int max) {
            return PortableBackup.clip(value, max);
        }
    }
}
