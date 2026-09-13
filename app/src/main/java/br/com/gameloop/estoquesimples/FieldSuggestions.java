package br.com.gameloop.estoquesimples;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

import br.com.gameloop.estoquesimples.data.LocalDb;

/**
 * Sugestões para campos de texto livre que, na prática, são listas
 * (categoria, unidade, fornecedor). Sem isso o mesmo grupo virava
 * "Vestuario", "Vestuário" e "vestuario" — e os relatórios por categoria
 * contavam três categorias diferentes.
 */
public final class FieldSuggestions {

    private static final String[] UNIDADES_COMUNS = {
            "un", "kg", "g", "L", "ml", "cx", "pct", "dz", "par", "m", "sc", "pote", "fardo"
    };

    private FieldSuggestions() {
    }

    public static void attach(SQLiteDatabase db, AutoCompleteTextView category,
                              AutoCompleteTextView unit, AutoCompleteTextView supplier) {
        if (category != null) {
            bind(category, distinct(db, "category", null));
        }
        if (unit != null) {
            bind(unit, distinct(db, "unit", UNIDADES_COMUNS));
        }
        if (supplier != null) {
            bind(supplier, distinct(db, "supplier", null));
        }
    }

    private static void bind(AutoCompleteTextView field, List<String> values) {
        field.setThreshold(1);
        field.setAdapter(new ArrayAdapter<>(field.getContext(),
                android.R.layout.simple_dropdown_item_1line, values));
        // Abre a lista também num toque, sem digitar nada: quem cadastra o
        // vigésimo produto quer escolher a categoria, não lembrar como escreveu.
        // O primeiro toque num campo só dá foco (não chega ao onClick), por
        // isso a lista abre no foco; o onClick cobre o segundo toque.
        field.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus && !values.isEmpty()) {
                field.post(() -> {
                    if (field.hasFocus() && !field.isPopupShowing()) field.showDropDown();
                });
            }
        });
        field.setOnClickListener(v -> {
            if (!values.isEmpty() && !field.isPopupShowing()) {
                field.showDropDown();
            }
        });
    }

    private static List<String> distinct(SQLiteDatabase db, String column, String[] defaults) {
        LinkedHashSet<String> values = new LinkedHashSet<>();
        // As unidades comuns vêm primeiro, na ordem em que se usa ("un" antes
        // de "dz"); o que o cadastro já tem de diferente entra depois.
        if (defaults != null) {
            for (String d : defaults) {
                values.add(d);
            }
        }
        if (db != null && db.isOpen()) {
            try (Cursor cursor = db.rawQuery(
                    "SELECT DISTINCT " + column + " FROM Estoque WHERE " + LocalDb.ACTIVE_PRODUCTS
                            + " AND " + column + " IS NOT NULL AND TRIM(" + column + ") != '' "
                            + "AND " + column + " != 'null' ORDER BY " + column + " COLLATE NOCASE",
                    null)) {
                while (cursor.moveToNext()) {
                    values.add(cursor.getString(0).trim());
                }
            } catch (Exception ignored) {
                // Sugestão é conveniência: sem ela o campo continua funcionando.
            }
        }
        return new ArrayList<>(values);
    }
}
