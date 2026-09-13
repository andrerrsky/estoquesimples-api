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
public class SettingsActivity extends BaseActivity {

    private static final String TAG = "SettingsActivity";
    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_SHOW_PRODUCT_IMAGES = "show_product_images";
    public static final String KEY_LOW_STOCK_ALERTS = "low_stock_alerts";

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

        setupLowStockAlerts(prefs);
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
    private androidx.appcompat.widget.SwitchCompat switchLowStockAlerts;
    private final androidx.activity.result.ActivityResultLauncher<String> notificationPermission =
            registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
                    granted -> {
                        if (!granted && switchLowStockAlerts != null) {
                            // Sem permissão o aviso não chega: o interruptor
                            // não pode ficar ligado fingindo que sim.
                            switchLowStockAlerts.setChecked(false);
                            android.widget.Toast.makeText(this,
                                    "Permita as notificações do Estoque Simples nas configurações do aparelho para receber os avisos.",
                                    android.widget.Toast.LENGTH_LONG).show();
                        }
                    });

    /**
     * Interruptor dos avisos de estoque baixo. No Android 13+ a notificação
     * exige permissão em tempo de execução, que o app nunca pedia — o aviso
     * simplesmente nunca aparecia. Ligar aqui pede a permissão na hora.
     */
    private void setupLowStockAlerts(SharedPreferences prefs) {
        switchLowStockAlerts = findViewById(R.id.switchLowStockAlerts);
        if (switchLowStockAlerts == null) {
            return;
        }
        boolean enabled = prefs.getBoolean(KEY_LOW_STOCK_ALERTS, true)
                && new NotificationHelper(this).hasNotificationPermission();
        switchLowStockAlerts.setChecked(enabled);
        switchLowStockAlerts.setOnCheckedChangeListener((buttonView, isChecked) -> {
            prefs.edit().putBoolean(KEY_LOW_STOCK_ALERTS, isChecked).apply();
            if (isChecked) {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
                        && !new NotificationHelper(this).hasNotificationPermission()) {
                    notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS);
                }
                LowStockScheduler.checkAndScheduleNotifications(this);
            } else {
                LowStockScheduler.cancelNotifications(this);
            }
        });
    }

    public static boolean isLowStockAlertsEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_LOW_STOCK_ALERTS, true);
    }

    public static boolean isShowProductImages(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY_SHOW_PRODUCT_IMAGES, true);
    }
}
