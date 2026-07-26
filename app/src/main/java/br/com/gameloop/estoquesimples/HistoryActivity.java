package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class HistoryActivity extends BaseActivity {

    private ListView historyList;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_history);

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        getSupportActionBar().setTitle(R.string.history_title);

        historyList = (ListView) findViewById(R.id.historyList);
        TextView emptyView = (TextView) findViewById(R.id.emptyHistory);
        historyList.setEmptyView(emptyView);

        loadHistory();
        
        // Configurar e mostrar anúncios com AdManager
        initializeAppodealAds();
    }
    
    /**
     * Inicializa e exibe os anúncios usando AdManager
     */
    private void initializeAppodealAds() {
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, 0);
        }
    }
    
    @Override
    protected void onResume() {
        super.onResume();
        // Atualizar anúncios baseado no status premium
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, 0);
        }
    }

    private void loadHistory() {
        List<HistoryAdapter.HistoryItem> items = new ArrayList<>();

        // Garantir que o banco de dados esteja inicializado antes de consultar.
        // Evita NullPointerException quando a Activity é recriada após a morte
        // do processo e MainActivity.stock ainda está nulo.
        if (!ensureDatabaseAvailable()) {
            Log.e("HistoryActivity", "Database not available, cannot load history");
            Toast.makeText(this, "Não foi possível carregar o histórico no momento.", Toast.LENGTH_LONG).show();
            historyList.setAdapter(new HistoryAdapter(this, items));
            return;
        }

        Cursor cursor = null;
        try {
            cursor = MainActivity.stock.rawQuery(
                    "SELECT product_name, change_type, quantity, timestamp, note FROM EstoqueHistorico ORDER BY timestamp DESC",
                    null
            );

            if (cursor != null && cursor.moveToFirst()) {
                do {
                    String product = cursor.getString(0);
                    String type = cursor.getString(1);
                    double qty = cursor.getDouble(2);
                    long ts = cursor.getLong(3);
                    String note = cursor.getString(4);

                    items.add(new HistoryAdapter.HistoryItem(product, type, qty, ts, note));
                } while (cursor.moveToNext());
            }
        } catch (Exception e) {
            Log.e("HistoryActivity", "Error loading history", e);
            Toast.makeText(this, "Erro ao carregar o histórico.", Toast.LENGTH_LONG).show();
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Exception ignored) {}
            }
        }

        HistoryAdapter adapter = new HistoryAdapter(this, items);
        historyList.setAdapter(adapter);

        historyList.setOnItemClickListener((parent, view, position, id) -> {
            Object obj = parent.getItemAtPosition(position);
            if (obj instanceof HistoryAdapter.HistoryItem) {
                showHistoryDetail((HistoryAdapter.HistoryItem) obj);
            }
        });
    }

    /**
     * Garante que o banco de dados está disponível e aberto, tentando
     * reinicializá-lo se necessário (process death, navegação direta, etc.).
     */
    private boolean ensureDatabaseAvailable() {
        try {
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }

            if (MainActivity.instance != null) {
                MainActivity.instance.openOrCreateDB();
                if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                    return true;
                }
            }

            // Última tentativa: abrir o banco diretamente a partir desta Activity
            MainActivity.stock = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
            return MainActivity.stock != null && MainActivity.stock.isOpen();
        } catch (Exception e) {
            Log.e("HistoryActivity", "Error ensuring database availability", e);
            return false;
        }
    }

    /**
     * Exibe um diálogo com o detalhamento completo da movimentação,
     * incluindo as observações/informações adicionais registradas na saída.
     */
    private void showHistoryDetail(HistoryAdapter.HistoryItem item) {
        boolean isEntrada = "entrada".equalsIgnoreCase(item.getType());
        String dateStr = new java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.getDefault())
                .format(new java.util.Date(item.getTimestamp()));

        StringBuilder sb = new StringBuilder();
        sb.append("Produto: ").append(item.getProductName()).append("\n");
        sb.append("Tipo: ").append(isEntrada ? "Entrada" : "Saída").append("\n");
        sb.append("Quantidade: ").append(CurrencyHelper.formatQuantity(item.getQuantity())).append("\n");
        sb.append("Data: ").append(dateStr);

        String note = item.getNote();
        if (note != null && !note.isEmpty() && !"null".equalsIgnoreCase(note)) {
            sb.append("\n\nObservações / Informações adicionais:\n").append(note);
        }

        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle(isEntrada ? "Detalhes da entrada" : "Detalhes da saída")
                .setMessage(sb.toString())
                .setPositiveButton("OK", null)
                .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.options_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int itemId = item.getItemId();
        
        if (itemId == android.R.id.home) {
            onBackPressed();
            return true;
        } else if (itemId == R.id.menu_analytics) {
            Intent intent = new Intent(this, AnalyticsActivity.class);
            startActivity(intent);
            return true;
        } else if (itemId == R.id.menu_about) {
            MainActivity.instance.showAboutActivity();
            return true;
        } else if (itemId == R.id.menu_history) {
            // Já estamos nesta tela
            return true;
        } else if (itemId == R.id.menu_settings) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}


