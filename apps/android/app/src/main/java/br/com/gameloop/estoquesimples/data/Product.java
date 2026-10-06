package br.com.gameloop.estoquesimples.data;

import android.database.Cursor;

/** Produto do estoque, como lido do banco local. */
public final class Product {

    public String uuid;
    public long id;
    public String name;
    public String description;
    public String amount;
    public String value;
    public String photo;
    /** SHA-256 da imagem na nuvem que {@link #photo} representa; nulo = ainda não enviada. */
    public String photoHash;
    /** Hash que a nuvem tinha quando a foto local foi trocada (ponto de partida do envio). */
    public String photoBaseHash;
    public String category;
    public String sku;
    public String barcode;
    public String supplier;
    public String location;
    public String minStock;
    public String unit;
    public long updatedAt;
    public Long deletedAt;
    public long rev;

    public static Product from(Cursor cursor) {
        Product product = new Product();
        product.id = getLong(cursor, "id");
        product.uuid = getString(cursor, "uuid");
        product.name = getString(cursor, "name");
        product.description = getString(cursor, "description");
        product.amount = getString(cursor, "amount");
        product.value = getString(cursor, "value");
        product.photo = getString(cursor, "photo");
        product.photoHash = getString(cursor, "photo_hash");
        product.photoBaseHash = getString(cursor, "photo_base_hash");
        product.category = getString(cursor, "category");
        product.sku = getString(cursor, "sku");
        product.barcode = getString(cursor, "barcode");
        product.supplier = getString(cursor, "supplier");
        product.location = getString(cursor, "location");
        product.minStock = getString(cursor, "min_stock");
        product.unit = getString(cursor, "unit");
        product.updatedAt = getLong(cursor, "updated_at");
        product.rev = getLong(cursor, "rev");

        int deletedIndex = cursor.getColumnIndex("deleted_at");
        product.deletedAt = deletedIndex >= 0 && !cursor.isNull(deletedIndex)
                ? cursor.getLong(deletedIndex)
                : null;

        return product;
    }

    public boolean isDeleted() {
        return deletedAt != null;
    }

    public double amountAsNumber() {
        return Quantities.parse(amount);
    }

    /**
     * Leitura tolerante a coluna ausente: um aparelho que ainda não migrou
     * pode não ter todas as colunas, e a tela precisa continuar funcionando.
     */
    private static String getString(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index >= 0 && !cursor.isNull(index) ? cursor.getString(index) : null;
    }

    private static long getLong(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index >= 0 && !cursor.isNull(index) ? cursor.getLong(index) : 0L;
    }
}
