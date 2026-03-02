package br.com.gameloop.estoquesimples;

import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.cardview.widget.CardView;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

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
public class AnalyticsActivity extends AppCompatActivity {

    private static final String TAG = "AnalyticsActivity";
    
    private PremiumManager premiumManager;
    private LinearLayout contentLayout;
    private LinearLayout lockedLayout;
    private TextView tvLockedMessage;
    
    // Analytics data structures
    private Map<String, ProductAnalytics> productAnalyticsMap;
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_analytics);
        
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Análise de Estoque");
        }
        
        // Inicializar PremiumManager
        premiumManager = PremiumManager.getInstance(this);
        
        // Inicializar views
        contentLayout = findViewById(R.id.analyticsContentLayout);
        lockedLayout = findViewById(R.id.analyticsLockedLayout);
        tvLockedMessage = findViewById(R.id.tvAnalyticsLockedMessage);
        
        // Verificar acesso premium
        if (premiumManager.hasPremiumAccess()) {
            showContent();
        } else {
            showLockedScreen();
        }
        
        // Configurar anúncios
        initializeAppodealAds();
    }
    
    /**
     * Mostra a tela bloqueada com mensagem de premium
     */
    private void showLockedScreen() {
        contentLayout.setVisibility(View.GONE);
        lockedLayout.setVisibility(View.VISIBLE);
        
        // Configurar mensagem
        tvLockedMessage.setText("🔒 Recurso Exclusivo Premium\n\n" +
                "A Análise Avançada de Estoque oferece:\n\n" +
                "📊 Previsão de esgotamento de produtos\n" +
                "📈 Taxa de rotatividade de estoque\n" +
                "💡 Recomendações de reabastecimento\n" +
                "⚡ Produtos de movimento rápido/lento\n" +
                "📉 Análise de tendências de consumo\n\n" +
                "Torne-se PRO ou ative 1 hora grátis para acessar!");
        
        // Botão para ir à tela PRO
        findViewById(R.id.btnGoProFromAnalytics).setOnClickListener(v -> {
            Intent intent = new Intent(this, ProActivity.class);
            startActivity(intent);
        });
        
        // Botão para assistir vídeo e ganhar 1 hora
        findViewById(R.id.btnWatchAdForAnalytics).setOnClickListener(v -> {
            showRewardedVideoOffer();
        });
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
                "SELECT name, amount, value, min_stock, unit FROM Estoque", null);
            
            if (cursor.moveToFirst()) {
                do {
                    String name = cursor.getString(0);
                    double amount = CurrencyHelper.parseCurrency(cursor.getString(1), 0);
                    double value = CurrencyHelper.parseCurrency(cursor.getString(2), 0.0);
                    double minStock = CurrencyHelper.parseCurrency(cursor.getString(3), 0);
                    String unit = cursor.getString(4);
                    
                    ProductAnalytics analytics = new ProductAnalytics(name);
                    analytics.currentStock = amount;
                    analytics.unitValue = value;
                    analytics.minStock = minStock;
                    analytics.unit = unit != null && !unit.isEmpty() && !unit.equals("null") ? unit : "un";
                    
                    productAnalyticsMap.put(name, analytics);
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
                "SELECT product_name, change_type, quantity, timestamp FROM EstoqueHistorico WHERE timestamp > ? ORDER BY timestamp DESC",
                new String[]{String.valueOf(ninetyDaysAgo)});
            
            if (cursor.moveToFirst()) {
                do {
                    String productName = cursor.getString(0);
                    String changeType = cursor.getString(1);
                    int quantity = cursor.getInt(2);
                    long timestamp = cursor.getLong(3);
                    
                    ProductAnalytics analytics = productAnalyticsMap.get(productName);
                    if (analytics != null) {
                        // Adicionar movimentação
                        analytics.movements.add(new StockMovement(changeType, quantity, timestamp));
                        
                        // Contar saídas (consumo)
                        if ("SAIDA".equalsIgnoreCase(changeType) || "VENDA".equalsIgnoreCase(changeType)) {
                            analytics.totalOutflow += quantity;
                        }
                        // Contar entradas
                        else if ("ENTRADA".equalsIgnoreCase(changeType) || "COMPRA".equalsIgnoreCase(changeType)) {
                            analytics.totalInflow += quantity;
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
            addHeaderCard(container, "⚠️ REABASTECIMENTO URGENTE", "#F44336");
            for (ProductAnalytics analytics : urgentProducts) {
                addProductCard(container, analytics, "#FFEBEE");
            }
        }
        
        // Mostrar produtos que precisam reabastecimento em breve
        if (!soonProducts.isEmpty()) {
            addHeaderCard(container, "🔔 REABASTECER EM BREVE", "#FF9800");
            for (ProductAnalytics analytics : soonProducts) {
                addProductCard(container, analytics, "#FFF3E0");
            }
        }
        
        // Mostrar produtos de movimento rápido
        if (!fastMovingProducts.isEmpty()) {
            addHeaderCard(container, "⚡ PRODUTOS DE MOVIMENTO RÁPIDO", "#4CAF50");
            for (ProductAnalytics analytics : fastMovingProducts) {
                addProductCard(container, analytics, "#E8F5E9");
            }
        }
        
        // Mostrar produtos de movimento lento
        if (!slowMovingProducts.isEmpty()) {
            addHeaderCard(container, "🐌 PRODUTOS DE MOVIMENTO LENTO", "#2196F3");
            for (ProductAnalytics analytics : slowMovingProducts) {
                addProductCard(container, analytics, "#E3F2FD");
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
        params.setMargins(0, 0, 0, 24);
        summaryView.setLayoutParams(params);
        summaryView.setPadding(32, 32, 32, 32);
        summaryView.setBackgroundColor(android.graphics.Color.parseColor("#E3F2FD"));
        summaryView.setTextSize(16);
        summaryView.setTextColor(android.graphics.Color.parseColor("#1976D2"));
        
        String summary = "📊 RESUMO DA ANÁLISE\n\n" +
                "Produtos analisados: " + productAnalyticsMap.size() + "\n" +
                "Reabastecimento urgente: " + urgent + "\n" +
                "Reabastecer em breve: " + soon + "\n" +
                "Movimento rápido: " + fast + "\n" +
                "Movimento lento: " + slow;
        
        summaryView.setText(summary);
        container.addView(summaryView);
    }
    
    /**
     * Adiciona um card de cabeçalho
     */
    private void addHeaderCard(LinearLayout container, String title, String color) {
        TextView headerView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 16, 0, 8);
        headerView.setLayoutParams(params);
        headerView.setPadding(16, 16, 16, 16);
        headerView.setBackgroundColor(android.graphics.Color.parseColor(color));
        headerView.setTextSize(18);
        headerView.setTextColor(android.graphics.Color.WHITE);
        headerView.setTypeface(null, android.graphics.Typeface.BOLD);
        headerView.setText(title);
        
        container.addView(headerView);
    }
    
    /**
     * Adiciona um card de produto com análise
     */
    private void addProductCard(LinearLayout container, ProductAnalytics analytics, String bgColor) {
        TextView cardView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 0, 0, 12);
        cardView.setLayoutParams(params);
        cardView.setPadding(24, 24, 24, 24);
        cardView.setBackgroundColor(android.graphics.Color.parseColor(bgColor));
        cardView.setTextSize(14);
        cardView.setTextColor(android.graphics.Color.parseColor("#212121"));
        
        StringBuilder text = new StringBuilder();
        text.append("📦 ").append(analytics.productName).append("\n\n");
        text.append("Estoque atual: ").append(String.format("%.1f", analytics.currentStock))
            .append(" ").append(analytics.unit).append("\n");
        
        if (analytics.avgDailyConsumption > 0) {
            text.append("Consumo médio: ").append(String.format("%.1f", analytics.avgDailyConsumption))
                .append(" ").append(analytics.unit).append("/dia\n");
        }
        
        if (analytics.daysUntilStockOut > 0) {
            text.append("Dias até esgotar: ").append(String.format("%.0f", analytics.daysUntilStockOut))
                .append(" dias\n");
            
            // Calcular data aproximada de esgotamento
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
            text.append("\n💡 Recomendação: Reabastecer em breve!");
        }
        
        cardView.setText(text.toString());
        container.addView(cardView);
    }
    
    /**
     * Adiciona card informando que não há dados suficientes
     */
    private void addNoDataCard(LinearLayout container) {
        TextView noDataView = new TextView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 32, 0, 32);
        noDataView.setLayoutParams(params);
        noDataView.setPadding(32, 32, 32, 32);
        noDataView.setBackgroundColor(android.graphics.Color.parseColor("#FFF3E0"));
        noDataView.setTextSize(16);
        noDataView.setTextColor(android.graphics.Color.parseColor("#E65100"));
        noDataView.setGravity(android.view.Gravity.CENTER);
        
        noDataView.setText("📊 DADOS INSUFICIENTES\n\n" +
                "Não há dados suficientes para gerar análises.\n\n" +
                "Continue registrando entradas e saídas no histórico para que possamos calcular:\n" +
                "• Previsões de esgotamento\n" +
                "• Taxa de rotatividade\n" +
                "• Recomendações personalizadas");
        
        container.addView(noDataView);
    }
    
    /**
     * Mostra oferta de vídeo recompensado
     */
    private void showRewardedVideoOffer() {
        new AlertDialog.Builder(this)
            .setTitle("🎬 1 Hora Sem Anúncios")
            .setMessage("Assista um vídeo curto e ganhe 1 HORA completa sem anúncios + acesso à Análise de Estoque!\n\nDeseja continuar?")
            .setPositiveButton("Assistir", (dialog, which) -> {
                AdManager adManager = AdManager.getInstance(this);
                adManager.showRewardedVideoForPremium(this);
            })
            .setNegativeButton("Agora Não", null)
            .show();
    }
    
    /**
     * Inicializa anúncios do Appodeal
     */
    private void initializeAppodealAds() {
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, 0);
        }
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
            
            MainActivity.stock = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
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
        
        // Atualizar anúncios
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, 0);
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
        } else if (itemId == R.id.menu_go_pro) {
            Intent intent = new Intent(this, ProActivity.class);
            startActivity(intent);
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
        int quantity;
        long timestamp;
        
        StockMovement(String type, int quantity, long timestamp) {
            this.type = type;
            this.quantity = quantity;
            this.timestamp = timestamp;
        }
    }
}

