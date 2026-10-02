package br.com.gameloop.estoquesimples.data;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Cópia portátil no mesmo formato que a API usa na sincronização.
 *
 * O arquivo {@code .db} é o backup nativo deste aparelho, mas não serve para
 * abrir numa planilha nem para reenviar à nuvem. Este JSON replica os campos
 * de {@code productInput} e {@code movementInput}: uuid do aparelho, quantidade
 * com sinal nas movimentações, nomes em camelCase. Um dump da nuvem e um
 * export daqui são intercambiáveis.
 *
 * <p>A foto fica de fora de propósito — é um caminho local, inútil em outro
 * aparelho e ausente do contrato de sync.
 */
public final class PortableBackup {

    public static final String FORMAT = "estoquesimples.backup";
    public static final int VERSION = 1;

    private PortableBackup() {
    }

    public static boolean isBackup(JSONObject json) {
        if (json == null) {
            return false;
        }
        String format = json.optString("format", "");
        return FORMAT.equals(format)
                || json.has("products")
                || json.has("produtos");
    }

    public static JSONArray productsOf(JSONObject json) {
        if (json == null) {
            return new JSONArray();
        }
        JSONArray products = json.optJSONArray("products");
        if (products != null) {
            return products;
        }
        products = json.optJSONArray("produtos");
        return products != null ? products : new JSONArray();
    }

    public static JSONArray movementsOf(JSONObject json) {
        if (json == null) {
            return new JSONArray();
        }
        JSONArray movements = json.optJSONArray("movements");
        if (movements != null) {
            return movements;
        }
        movements = json.optJSONArray("movimentacoes");
        return movements != null ? movements : new JSONArray();
    }

    static JSONObject product(Product product) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("id", product.uuid);
        json.put("name", nullToEmpty(product.name));
        putOptional(json, "description", product.description);
        json.put("quantity", product.amountAsNumber());
        json.put("unitValue", Quantities.parse(product.value));
        json.put("minStock", Quantities.parse(product.minStock));
        putOptional(json, "unit", product.unit);
        putOptional(json, "category", product.category);
        putOptional(json, "supplier", product.supplier);
        putOptional(json, "location", product.location);
        putOptional(json, "sku", product.sku);
        putOptional(json, "barcode", product.barcode);
        json.put("rev", product.rev);
        json.put("updatedAt", product.updatedAt);
        if (product.deletedAt != null) {
            json.put("deletedAt", product.deletedAt);
        }
        return json;
    }

    static JSONObject movement(String id, String productId, String productName,
                               String changeType, double storedQuantity, long occurredAt,
                               String note) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("id", id);
        if (productId != null && !productId.isEmpty()) {
            json.put("productId", productId);
        }
        putOptional(json, "productName", productName);
        json.put("changeType", changeType == null ? "" : changeType);
        json.put("quantity", MovementRepository.signedQuantity(changeType, storedQuantity));
        json.put("occurredAt", occurredAt);
        putOptional(json, "note", note);
        return json;
    }

    static void putOptional(JSONObject json, String key, String value) throws JSONException {
        if (value != null && !value.trim().isEmpty()) {
            json.put(key, value);
        }
    }

    static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    static String clip(String value, int max) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        if (trimmed.length() <= max) {
            return trimmed;
        }
        return trimmed.substring(0, max);
    }
}
