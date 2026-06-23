package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Spinner;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;

/**
 * Tela de configurações do aplicativo.
 * Permite:
 *  - exibir/ocultar as imagens dos produtos na listagem principal;
 *  - definir a moeda padrão usada automaticamente nas telas de criação/edição.
 *
 * Todas as preferências são salvas em SharedPreferences (sem qualquer impacto
 * no banco de dados dos usuários).
 */
public class SettingsActivity extends AppCompatActivity {

    private static final String TAG = "SettingsActivity";
    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_SHOW_PRODUCT_IMAGES = "show_product_images";

    private SwitchCompat switchShowImages;
    private Spinner spinnerDefaultCurrency;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle(R.string.settings_title);
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }

        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        switchShowImages = findViewById(R.id.switchShowImages);
        spinnerDefaultCurrency = findViewById(R.id.spinnerDefaultCurrency);

        setupShowImagesSwitch(prefs);
        setupCurrencySpinner();
    }

    private void setupShowImagesSwitch(final SharedPreferences prefs) {
        if (switchShowImages == null) {
            Log.e(TAG, "switchShowImages is null");
            return;
        }
        boolean showImages = prefs.getBoolean(KEY_SHOW_PRODUCT_IMAGES, true);
        switchShowImages.setChecked(showImages);
        switchShowImages.setOnCheckedChangeListener((buttonView, isChecked) ->
                prefs.edit().putBoolean(KEY_SHOW_PRODUCT_IMAGES, isChecked).apply());
    }

    private void setupCurrencySpinner() {
        if (spinnerDefaultCurrency == null) {
            Log.e(TAG, "spinnerDefaultCurrency is null");
            return;
        }
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_item, CurrencyHelper.AVAILABLE_CURRENCIES);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinnerDefaultCurrency.setAdapter(adapter);

        String current = CurrencyHelper.getCurrencySymbol(this);
        for (int i = 0; i < CurrencyHelper.AVAILABLE_CURRENCIES.length; i++) {
            if (CurrencyHelper.AVAILABLE_CURRENCIES[i].equals(current)) {
                spinnerDefaultCurrency.setSelection(i);
                break;
            }
        }

        spinnerDefaultCurrency.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                String selected = CurrencyHelper.AVAILABLE_CURRENCIES[position];
                CurrencyHelper.setCurrencySymbol(SettingsActivity.this, selected);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    /**
     * Indica se as imagens dos produtos devem ser exibidas na listagem.
     * Default: true (mantém o comportamento anterior para usuários existentes).
     */
    public static boolean isShowProductImages(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY_SHOW_PRODUCT_IMAGES, true);
    }
}
