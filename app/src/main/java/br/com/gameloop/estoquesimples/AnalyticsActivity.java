package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;

import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Atividade Premium: Análise Avançada de Estoque
 * 
 * Fornece análises preditivas e insights sobre movimentação de estoque:
 * - Previsão de esgotamento de estoque
 * - Taxa de rotatividade de produtos
 * - Recomendações de reabastecimento
 * - Produtos de movimento rápido/lento
 */
public class AnalyticsActivity extends BaseActivity {

    private static final String TAG = "AnalyticsActivity";
    
    private PremiumManager premiumManager;
    private LinearLayout contentLayout;
    private LinearLayout lockedLayout;
    
    // Analytics data structures
    private Map<String, ProductAnalytics> productAnalyticsMap;
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_analytics);
        
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Análise de Estoque");
            // "Relatórios" (aba principal) e esta tela mostram números de
            // formas diferentes; o subtítulo existe só para deixar claro qual
            // é qual na hora de escolher entre as duas.
            getSupportActionBar().setSubtitle("Gráficos e tendências");
        }
        
        // Inicializar PremiumManager
        premiumManager = PremiumManager.getInstance(this);
        
        // Inicializar views
        contentLayout = findViewById(R.id.analyticsContentLayout);
        lockedLayout = findViewById(R.id.analyticsLockedLayout);
        
        // Verificar acesso premium
        if (premiumManager.hasPremiumAccess()) {
            showContent();
        } else {
            showLockedScreen();
        }
    }
    
    /**
     * Mostra a tela bloqueada com mensagem de premium
     */
    private void showLockedScreen() {
        contentLayout.setVisibility(View.GONE);
        lockedLayout.setVisibility(View.VISIBLE);

        findViewById(R.id.btnGoProFromAnalytics).setOnClickListener(v ->
                SubscriptionActivity.open(this));
    }
    
    /**
     * Mostra o conteúdo da análise (usuário premium)
     */
    private void showContent() {
        contentLayout.setVisibility(View.VISIBLE);
        lockedLayout.setVisibility(View.GONE);
        
        // Gerar análises
        generateAnalytics();
    }
    
    /**
     * Gera as análises de estoque
     */
    private void generateAnalytics() {
        try {
            // Verificar se o banco de dados está disponível
            if (!ensureDatabaseAvailable()) {
                Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
                return;
            }
            
            // Coletar dados dos produtos
            productAnalyticsMap = new HashMap<>();
            collectProductData();
            
            // Coletar histórico de movimentações
            collectHistoryData();
            
            // Calcular análises
            calculateAnalytics();
            
            // Exibir resultados
            displayAnalytics();
            
        } catch (Exception e) {
            Log.e(TAG, "Error generating analytics", e);
            Toast.makeText(this, "Erro ao gerar análises: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }
    
    /**
     * Coleta dados básicos dos produtos
     */
    private void collectProductData() {
        Cursor cursor = null;
        try {
            cursor = MainActivity.stock.rawQuery(
                "SELECT uuid, name, amount, value, min_stock, unit FROM Estoque WHERE "
                    + LocalDb.ACTIVE_PRODUCTS, null);
            
            if (cursor.moveToFirst()) {
                do {
                    String uuid = cursor.getString(0);
                    String name = cursor.getString(1);
                    double amount = CurrencyHelper.parseCurrency(cursor.getString(2), 0);
                    double value = CurrencyHelper.parseCurrency(cursor.getString(3), 0.0);
                    double minStock = CurrencyHelper.parseCurrency(cursor.getString(4), 0);
                    String unit = cursor.getString(5);
                    
                    ProductAnalytics analytics = new ProductAnalytics(name);
                    analytics.currentStock = amount;
                    analytics.unitValue = value;
                    analytics.minStock = minStock;
                    analytics.unit = unit != null && !unit.isEmpty() && !unit.equals("null") ? unit : "un";
                    
                    // A chave é o uuid: indexar por nome fazia um produto
                    // renomeado aparecer sem nenhuma movimentação, e a previsão
                    // de reposição dele saía como "sem dados".
                    productAnalyticsMap.put(uuid, analytics);
                } while (cursor.moveToNext());
            }
        } finally {
            if (cursor != null) cursor.close();
        }
    }
    
    /**
     * Coleta dados do histórico de movimentações
     */
    private void collectHistoryData() {
        Cursor cursor = null;
        try {
            // Buscar movimentações dos últimos 90 dias
            long ninetyDaysAgo = System.currentTimeMillis() - (90L * 24 * 60 * 60 * 1000);
            
            cursor = MainActivity.stock.rawQuery(
                "SELECT product_uuid, change_type, quantity, timestamp FROM EstoqueHistorico "
                    + "WHERE timestamp > ? AND deleted_at IS NULL ORDER BY timestamp DESC",
                new String[]{String.valueOf(ninetyDaysAgo)});
            
            if (cursor.moveToFirst()) {
                do {
                    String productUuid = cursor.getString(0);
                    String changeType = cursor.getString(1);
                    double quantity = cursor.getDouble(2);
                    long timestamp = cursor.getLong(3);
                    
                    ProductAnalytics analytics = productAnalyticsMap.get(productUuid);
                    if (analytics != null) {
                        analytics.movements.add(new StockMovement(changeType, quantity, timestamp));

                        // O efeito no saldo decide o lado: um ajuste para menos
                        // é consumo tanto quanto uma saída, e a previsão de
                        // reposição ficava otimista por ignorá-lo.
                        double effect = MovementRepository.signedQuantity(changeType, quantity);
                        if (effect < 0) {
                            analytics.totalOutflow += -effect;
                        } else {
                            analytics.totalInflow += effect;
                        }
                    }
                } while (cursor.moveToNext());
            }
        } finally {
            if (cursor != null) cursor.close();
        }
    }
    
    /**
     * Calcula as análises para cada produto
     */
    private void calculateAnalytics() {
        long currentTime = System.currentTimeMillis();
        
        for (ProductAnalytics analytics : productAnalyticsMap.values()) {
            // Calcular apenas se houver movimentações
            if (!analytics.movements.isEmpty()) {
                // Pegar timestamp da movimentação mais antiga
                long oldestTimestamp = analytics.movements.get(analytics.movements.size() - 1).timestamp;
                long daysWithData = (currentTime - oldestTimestamp) / (24 * 60 * 60 * 1000);
                daysWithData = Math.max(1, daysWithData); // Mínimo 1 dia
                
                // Calcular consumo médio diário (baseado em saídas)
                if (analytics.totalOutflow > 0) {
                    analytics.avgDailyConsumption = analytics.totalOutflow / (double) daysWithData;
                    
                    // Calcular dias até esgotamento
                    if (analytics.avgDailyConsumption > 0) {
                        analytics.daysUntilStockOut = analytics.currentStock / analytics.avgDailyConsumption;
                    }
                }
                
                // Calcular taxa de rotatividade (turnover)
                if (analytics.currentStock > 0) {
                    analytics.turnoverRate = analytics.totalOutflow / analytics.currentStock;
                }
                
                // Determinar velocidade de movimento
                if (analytics.avgDailyConsumption >= 5) {
                    analytics.movementSpeed = "Rápido";
                } else if (analytics.avgDailyConsumption >= 1) {
                    analytics.movementSpeed = "Médio";
                } else if (analytics.avgDailyConsumption > 0) {
                    analytics.movementSpeed = "Lento";
                } else {
                    analytics.movementSpeed = "Parado";
                }
                
                // Recomendar reabastecimento
                if (analytics.daysUntilStockOut > 0 && analytics.daysUntilStockOut <= 7) {
                    analytics.needsRestocking = true;
                    analytics.restockingPriority = "URGENTE";
                } else if (analytics.daysUntilStockOut > 7 && analytics.daysUntilStockOut <= 15) {
                    analytics.needsRestocking = true;
                    analytics.restockingPriority = "BREVE";
                } else if (analytics.currentStock <= analytics.minStock && analytics.minStock > 0) {
                    analytics.needsRestocking = true;
                    analytics.restockingPriority = "ATENÇÃO";
                }
            }
        }
    }
    
    /**
     * Exibe as análises na interface
     */
    private void displayAnalytics() {
        LinearLayout container = findViewById(R.id.analyticsCardsContainer);
        container.removeAllViews();
        
        // Separar produtos por prioridade
        List<ProductAnalytics> urgentProducts = new ArrayList<>();
        List<ProductAnalytics> soonProducts = new ArrayList<>();
        List<ProductAnalytics> fastMovingProducts = new ArrayList<>();
        List<ProductAnalytics> slowMovingProducts = new ArrayList<>();
        
        for (ProductAnalytics analytics : productAnalyticsMap.values()) {
            if ("URGENTE".equals(analytics.restockingPriority)) {
                urgentProducts.add(analytics);
            } else if ("BREVE".equals(analytics.restockingPriority)) {
                soonProducts.add(analytics);
            }
            
            if ("Rápido".equals(analytics.movementSpeed)) {
                fastMovingProducts.add(analytics);
            } else if ("Lento".equals(analytics.movementSpeed) || "Parado".equals(analytics.movementSpeed)) {
                slowMovingProducts.add(analytics);
            }
        }
        
        // Mostrar resumo geral
        addSummaryCard(container, urgentProducts.size(), soonProducts.size(), 
                       fastMovingProducts.size(), slowMovingProducts.size());
        
        // Mostrar produtos que precisam reabastecimento urgente
        if (!urgentProducts.isEmpty()) {
            addHeaderCard(container, getString(R.string.analytics_urgent_restock), R.color.color_error);
            for (ProductAnalytics analytics : urgentProducts) {
                addProductCard(container, analytics);
            }
        }

        if (!soonProducts.isEmpty()) {
            addHeaderCard(container, getString(R.string.analytics_soon_restock), R.color.color_warning);
            for (ProductAnalytics analytics : soonProducts) {
                addProductCard(container, analytics);
            }
        }

        if (!fastMovingProducts.isEmpty()) {
            addHeaderCard(container, getString(R.string.analytics_fast_moving), R.color.color_success);
            for (ProductAnalytics analytics : fastMovingProducts) {
                addProductCard(container, analytics);
            }
        }

        if (!slowMovingProducts.isEmpty()) {
            addHeaderCard(container, getString(R.string.analytics_slow_moving), R.color.color_brand);
            for (ProductAnalytics analytics : slowMovingProducts) {
                addProductCard(container, analytics);
            }
        }
        
        // Se não houver dados suficientes
        if (productAnalyticsMap.isEmpty() || 
            (urgentProducts.isEmpty() && soonProducts.isEmpty() && 
             fastMovingProducts.isEmpty() && slowMovingProducts.isEmpty())) {
            addNoDataCard(container);
        }
    }
    
    /**
     * Adiciona card com resumo geral
     */
    private void addSummaryCard(LinearLayout container, int urgent, int soon, int fast, int slow) {
        TextView summaryView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 0, 0, dp(16));
        summaryView.setLayoutParams(params);
        int pad = dp(18);
        summaryView.setPadding(pad, pad, pad, pad);
        summaryView.setBackgroundResource(R.drawable.bg_surface);
        summaryView.setTextAppearance(R.style.TextAppearance_Estoque_Body);
        summaryView.setTextColor(ContextCompat.getColor(this, R.color.color_text));

        String summary = getString(R.string.analytics_summary_title) + "\n\n" +
                "Produtos analisados: " + productAnalyticsMap.size() + "\n" +
                "Reabastecimento urgente: " + urgent + "\n" +
                "Reabastecer em breve: " + soon + "\n" +
                "Movimento rápido: " + fast + "\n" +
                "Movimento lento: " + slow;

        summaryView.setText(summary);
        container.addView(summaryView);
    }

    private void addHeaderCard(LinearLayout container, String title, int colorRes) {
        TextView headerView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, dp(16), 0, dp(8));
        headerView.setLayoutParams(params);
        headerView.setTextAppearance(R.style.TextAppearance_Estoque_Section);
        headerView.setTextColor(ContextCompat.getColor(this, colorRes));
        headerView.setText(title);
        container.addView(headerView);
    }

    private void addProductCard(LinearLayout container, ProductAnalytics analytics) {
        TextView cardView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 0, 0, dp(10));
        cardView.setLayoutParams(params);
        int pad = dp(16);
        cardView.setPadding(pad, pad, pad, pad);
        cardView.setBackgroundResource(R.drawable.bg_surface);
        cardView.setTextAppearance(R.style.TextAppearance_Estoque_Supporting);
        cardView.setTextColor(ContextCompat.getColor(this, R.color.color_text));

        StringBuilder text = new StringBuilder();
        text.append(analytics.productName).append("\n\n");
        text.append("Estoque atual: ").append(CurrencyHelper.formatQuantity(analytics.currentStock))
            .append(" ").append(analytics.unit).append("\n");

        if (analytics.avgDailyConsumption > 0) {
            text.append("Consumo médio: ").append(String.format("%.1f", analytics.avgDailyConsumption))
                .append(" ").append(analytics.unit).append("/dia\n");
        }

        if (analytics.daysUntilStockOut > 0) {
            text.append("Dias até esgotar: ").append(String.format("%.0f", analytics.daysUntilStockOut))
                .append(" dias\n");

            long stockOutTimestamp = System.currentTimeMillis() +
                (long)(analytics.daysUntilStockOut * 24 * 60 * 60 * 1000);
            SimpleDateFormat sdf = new SimpleDateFormat("dd/MM/yyyy", Locale.getDefault());
            text.append("Previsão de esgotamento: ").append(sdf.format(new Date(stockOutTimestamp)))
                .append("\n");
        }

        text.append("Velocidade: ").append(analytics.movementSpeed).append("\n");

        if (analytics.turnoverRate > 0) {
            text.append("Taxa de rotatividade: ").append(String.format("%.2fx", analytics.turnoverRate)).append("\n");
        }

        if (analytics.needsRestocking) {
            text.append("\n").append(getString(R.string.analytics_recommendation));
        }

        cardView.setText(text.toString());
        container.addView(cardView);
    }

    private void addNoDataCard(LinearLayout container) {
        TextView noDataView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, dp(16), 0, dp(16));
        noDataView.setLayoutParams(params);
        int pad = dp(18);
        noDataView.setPadding(pad, pad, pad, pad);
        noDataView.setBackgroundResource(R.drawable.bg_surface_muted);
        noDataView.setTextAppearance(R.style.TextAppearance_Estoque_Supporting);
        noDataView.setTextColor(ContextCompat.getColor(this, R.color.color_text_muted));
        noDataView.setGravity(android.view.Gravity.CENTER);

        noDataView.setText(getString(R.string.analytics_insufficient_title) + "\n\n" +
                getString(R.string.analytics_no_data));

        container.addView(noDataView);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
    
    /**
     * Garante que o banco de dados está disponível
     */
    private boolean ensureDatabaseAvailable() {
        try {
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }
            
            if (MainActivity.instance != null) {
                MainActivity.instance.openOrCreateDB();
                return MainActivity.stock != null && MainActivity.stock.isOpen();
            }
            
            MainActivity.stock = LocalDb.open(this);
            return MainActivity.stock != null && MainActivity.stock.isOpen();
        } catch (Exception e) {
            Log.e(TAG, "Error ensuring database availability", e);
            return false;
        }
    }
    
    
    
    @Override
    protected void onResume() {
        super.onResume();
        // Verificar novamente o acesso premium ao retornar
        if (premiumManager.hasPremiumAccess() && lockedLayout.getVisibility() == View.VISIBLE) {
            showContent();
        }
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
        } else if (itemId == R.id.menu_subscription) {
            SubscriptionActivity.open(this);
            return true;
        } else if (itemId == R.id.menu_about) {
            Intent intent = new Intent(this, AboutActivity.class);
            startActivity(intent);
            return true;
        } else if (itemId == R.id.menu_history) {
            Intent intent = new Intent(this, HistoryActivity.class);
            startActivity(intent);
            return true;
        } else if (itemId == R.id.menu_exit) {
            finishAffinity();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
    
    /**
     * Classe interna para armazenar dados de análise de um produto
     */
    private static class ProductAnalytics {
        String productName;
        double currentStock = 0;
        double unitValue = 0;
        double minStock = 0;
        String unit = "un";
        
        List<StockMovement> movements = new ArrayList<>();
        double totalOutflow = 0;
        double totalInflow = 0;
        
        double avgDailyConsumption = 0;
        double daysUntilStockOut = 0;
        double turnoverRate = 0;
        String movementSpeed = "Sem dados";
        
        boolean needsRestocking = false;
        String restockingPriority = "";
        
        ProductAnalytics(String name) {
            this.productName = name;
        }
    }
    
    /**
     * Classe interna para representar uma movimentação de estoque
     */
    private static class StockMovement {
        String type;
        double quantity;
        long timestamp;
        
        StockMovement(String type, double quantity, long timestamp) {
            this.type = type;
            this.quantity = quantity;
            this.timestamp = timestamp;
        }
    }
}

