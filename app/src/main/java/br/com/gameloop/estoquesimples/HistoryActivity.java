package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;
import android.view.Menu;
import android.view.MenuItem;
import android.widget.ListView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class HistoryActivity extends AppCompatActivity {

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

        Cursor cursor = MainActivity.stock.rawQuery(
                "SELECT product_name, change_type, quantity, timestamp, note FROM EstoqueHistorico ORDER BY timestamp DESC",
                null
        );

        if (cursor.moveToFirst()) {
            do {
                String product = cursor.getString(0);
                String type = cursor.getString(1);
                int qty = cursor.getInt(2);
                long ts = cursor.getLong(3);
                String note = cursor.getString(4);

                items.add(new HistoryAdapter.HistoryItem(product, type, qty, ts, note));
            } while (cursor.moveToNext());
        }
        cursor.close();

        HistoryAdapter adapter = new HistoryAdapter(this, items);
        historyList.setAdapter(adapter);
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
        }
        return super.onOptionsItemSelected(item);
    }
}


