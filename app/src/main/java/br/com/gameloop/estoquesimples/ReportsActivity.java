package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;

import android.Manifest;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import androidx.appcompat.app.AlertDialog;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.text.Html;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.github.mikephil.charting.charts.PieChart;
import com.github.mikephil.charting.data.PieData;
import com.github.mikephil.charting.data.PieDataSet;
import com.github.mikephil.charting.data.PieEntry;

public class ReportsActivity extends BaseActivity {

    private static final int PERMISSION_REQUEST_CODE = 100;

    private final ExecutorService pdfExecutor = Executors.newSingleThreadExecutor();
    private android.app.ProgressDialog pdfProgressDialog;
    private volatile boolean isExportingPdf = false;

    private PieChart chart;
    private View chartEmptyState;
    private PieData data;

    private String higherAmoutProductText;
    private String lowerAmoutProductText;
    private double higherAmoutProductValue;
    private double lowerAmoutProductValue;

    private TextView higher;
    private TextView lower;
    private TextView totalProducts;
    private TextView totalItems;
    private TextView totalValue;
    private TextView averageValue;
    private TextView totalEntryValue;
    private TextView totalExitValue;
    private TextView lowStockWarning;
    private TextView lowStockList;
    private TextView categoriesList;
    private TextView categoryTitle;
    private View categorySection;
    private View dividerLowStock;
    private Button btnExportPdf;
    private Button btnReportMovements;
    private Button btnReportExits;
    private Button btnReportEntries;
    private Button btnReportLowStock;
    private Button btnReportCategory;
    private Button btnReportFinancial;

    // Tipo de relatório e período pendentes para exportação (usados também
    // após concessão de permissão em onRequestPermissionsResult).
    private ReportType pendingReportType = ReportType.COMPLETO;
    private Period pendingPeriod = Period.TUDO;

    /** Tipos de relatório disponíveis para exportação em PDF. */
    private enum ReportType {
        COMPLETO,
        MOVIMENTACOES,
        SAIDAS,
        ENTRADAS,
        ESTOQUE_BAIXO,
        CATEGORIA,
        FINANCEIRO
    }

    /** Períodos pré-definidos para relatórios baseados no histórico. */
    private enum Period {
        HOJE("Hoje"),
        DIAS_7("Últimos 7 dias"),
        DIAS_30("Últimos 30 dias"),
        DIAS_90("Últimos 90 dias"),
        TUDO("Todo o período");

        private final String label;

        Period(String label) {
            this.label = label;
        }

        String getLabel() {
            return label;
        }

        /**
         * Retorna o timestamp (millis) a partir do qual as movimentações devem
         * ser incluídas. Para TUDO retorna 0 (sem corte).
         */
        long cutoffMillis() {
            switch (this) {
                case HOJE: {
                    java.util.Calendar c = java.util.Calendar.getInstance();
                    c.set(java.util.Calendar.HOUR_OF_DAY, 0);
                    c.set(java.util.Calendar.MINUTE, 0);
                    c.set(java.util.Calendar.SECOND, 0);
                    c.set(java.util.Calendar.MILLISECOND, 0);
                    return c.getTimeInMillis();
                }
                case DIAS_7:
                    return System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000;
                case DIAS_30:
                    return System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000;
                case DIAS_90:
                    return System.currentTimeMillis() - 90L * 24 * 60 * 60 * 1000;
                case TUDO:
                default:
                    return 0L;
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        try {
            setContentView(R.layout.activity_reports);

            SectionNav.attach(this, R.id.navigation_reports);
            if (getSupportActionBar() != null) {
                getSupportActionBar().setTitle("Relatórios");
                // Ver "Análise de Estoque" (menu ⋮) mostra gráficos e
                // tendências; aqui é o resumo do período com exportação.
                getSupportActionBar().setSubtitle("Resumo do estoque e exportação");
            }

            // Inicializar views de forma segura
            chart = (PieChart) findViewById(R.id.chart);
            chartEmptyState = findViewById(R.id.chartEmptyState);
            higher = (TextView) findViewById(R.id.higher);
            lower = (TextView) findViewById(R.id.lower);
            totalProducts = (TextView) findViewById(R.id.totalProducts);
            totalItems = (TextView) findViewById(R.id.totalItems);
            totalValue = (TextView) findViewById(R.id.totalValue);
            averageValue = (TextView) findViewById(R.id.averageValue);
            totalEntryValue = (TextView) findViewById(R.id.totalEntryValue);
            totalExitValue = (TextView) findViewById(R.id.totalExitValue);
            lowStockWarning = (TextView) findViewById(R.id.lowStockWarning);
            lowStockList = (TextView) findViewById(R.id.lowStockList);
            categoriesList = (TextView) findViewById(R.id.categoriesList);
            categoryTitle = (TextView) findViewById(R.id.categoryTitle);
            categorySection = findViewById(R.id.categorySection);
            dividerLowStock = findViewById(R.id.dividerLowStock);
            btnExportPdf = (Button) findViewById(R.id.btnExportPdf);
            btnReportMovements = (Button) findViewById(R.id.btnReportMovements);
            btnReportExits = (Button) findViewById(R.id.btnReportExits);
            btnReportEntries = (Button) findViewById(R.id.btnReportEntries);
            btnReportLowStock = (Button) findViewById(R.id.btnReportLowStock);
            btnReportCategory = (Button) findViewById(R.id.btnReportCategory);
            btnReportFinancial = (Button) findViewById(R.id.btnReportFinancial);

            // Verificar se os campos obrigatórios foram inicializados
            if (!areFieldsInitialized()) {
                Log.e("ReportsActivity", "Critical fields not initialized");
                Toast.makeText(this, "Erro ao carregar interface. Por favor, reinicie o aplicativo.", Toast.LENGTH_LONG).show();
                finish();
                return;
            }

            generateData();

        // Configurar botões de exportação de PDF
        btnExportPdf.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startReport(ReportType.COMPLETO);
            }
        });

        View openAnalyticsCard = findViewById(R.id.openAnalyticsCard);
        if (openAnalyticsCard != null) {
            openAnalyticsCard.setOnClickListener(v ->
                    startActivity(new Intent(this, AnalyticsActivity.class)));

            // Avisa antes do clique que a Análise pode pedir assinatura, em
            // vez de deixar quem clicar cair de surpresa numa tela de venda.
            TextView analyticsBadge = findViewById(R.id.openAnalyticsBadge);
            if (analyticsBadge != null) {
                boolean precisaAssinatura = !PremiumManager.getInstance(this).hasPremiumAccess();
                analyticsBadge.setVisibility(precisaAssinatura ? View.VISIBLE : View.GONE);
            }
        }

        if (btnReportMovements != null) {
            btnReportMovements.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startReport(ReportType.MOVIMENTACOES);
                }
            });
        }
        if (btnReportExits != null) {
            btnReportExits.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startReport(ReportType.SAIDAS);
                }
            });
        }
        if (btnReportEntries != null) {
            btnReportEntries.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startReport(ReportType.ENTRADAS);
                }
            });
        }
        if (btnReportLowStock != null) {
            btnReportLowStock.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startReport(ReportType.ESTOQUE_BAIXO);
                }
            });
        }
        if (btnReportCategory != null) {
            btnReportCategory.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startReport(ReportType.CATEGORIA);
                }
            });
        }
        if (btnReportFinancial != null) {
            btnReportFinancial.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startReport(ReportType.FINANCEIRO);
                }
            });
        }

        } catch (Exception e) {
            Log.e("ReportsActivity", "Critical error in onCreate", e);
            Toast.makeText(this, "Erro ao inicializar tela de relatórios: " + e.getMessage(), Toast.LENGTH_LONG).show();
            // Tentar mostrar pelo menos um estado vazio
            try {
                showEmptyState();
            } catch (Exception ex) {
                Log.e("ReportsActivity", "Error showing empty state", ex);
            }
        }

    }
    
    /**
     * Verifica se todos os campos obrigatórios foram inicializados
     * @return true se todos os campos obrigatórios não são null
     */
    private boolean areFieldsInitialized() {
        boolean allInitialized = true;
        
        if (chart == null) {
            Log.e("ReportsActivity", "chart is null");
            allInitialized = false;
        }
        if (higher == null) {
            Log.e("ReportsActivity", "higher is null");
            allInitialized = false;
        }
        if (lower == null) {
            Log.e("ReportsActivity", "lower is null");
            allInitialized = false;
        }
        if (totalProducts == null) {
            Log.e("ReportsActivity", "totalProducts is null");
            allInitialized = false;
        }
        if (totalItems == null) {
            Log.e("ReportsActivity", "totalItems is null");
            allInitialized = false;
        }
        if (totalValue == null) {
            Log.e("ReportsActivity", "totalValue is null");
            allInitialized = false;
        }
        if (btnExportPdf == null) {
            Log.e("ReportsActivity", "btnExportPdf is null");
            allInitialized = false;
        }
        
        return allInitialized;
    }


    @Override
    protected void onDestroy() {
        super.onDestroy();
        dismissPdfProgressDialog();
        try {
            pdfExecutor.shutdownNow();
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error shutting down PDF executor", e);
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.section_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return AppMenu.handle(this, item) || super.onOptionsItemSelected(item);
    }
    

    /**
     * Mantém as {@code maximo} maiores fatias e soma as demais em "Outros".
     */
    private static List<PieEntry> agruparFatias(List<PieEntry> entries, int maximo) {
        if (entries.size() <= maximo + 1) {
            return entries;
        }
        List<PieEntry> ordenadas = new ArrayList<>(entries);
        java.util.Collections.sort(ordenadas, (a, b) -> Float.compare(b.getValue(), a.getValue()));
        List<PieEntry> resultado = new ArrayList<>(ordenadas.subList(0, maximo));
        float resto = 0f;
        int quantos = 0;
        for (PieEntry e : ordenadas.subList(maximo, ordenadas.size())) {
            resto += e.getValue();
            quantos++;
        }
        resultado.add(new PieEntry(resto, "Outros (" + quantos + " produtos)"));
        return resultado;
    }

    private static void somarPorUnidade(java.util.Map<String, Double> mapa, String unidade, double quantidade) {
        String chave = unidade == null || unidade.trim().isEmpty() || "null".equals(unidade) ? "un" : unidade.trim();
        Double atual = mapa.get(chave);
        mapa.put(chave, (atual == null ? 0 : atual) + quantidade);
    }

    /** "812 un · 65,4 kg · 40 pct" (as maiores primeiro; mais de quatro vira "…"). */
    private static String descreverPorUnidade(java.util.Map<String, Double> mapa, double total) {
        if (mapa.isEmpty()) {
            return CurrencyHelper.formatQuantity(total);
        }
        List<java.util.Map.Entry<String, Double>> entradas = new ArrayList<>(mapa.entrySet());
        java.util.Collections.sort(entradas, (a, b) -> Double.compare(b.getValue(), a.getValue()));
        StringBuilder sb = new StringBuilder();
        for (java.util.Map.Entry<String, Double> e : entradas) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(CurrencyHelper.formatQuantity(e.getValue())).append(' ').append(e.getKey());
        }
        return sb.toString();
    }

    private void generateData() {

        List<PieEntry> entries = new ArrayList<>();

        // Verificar e inicializar banco de dados se necessário
        if (!ensureDatabaseAvailable()) {
            Log.e("ReportsActivity", "Database is not available and could not be initialized");
            Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_LONG).show();
            showEmptyState();
            return;
        }

        Cursor cursor = null;
        try {
            cursor = MainActivity.stock.rawQuery("SELECT name, amount, value, min_stock, category, unit FROM Estoque WHERE " + LocalDb.ACTIVE_PRODUCTS, null);

        int cursorCount = cursor.getCount();
        double totalItemsCount = 0;
        double totalValueSum = 0.0;
        List<String> lowStockProducts = new ArrayList<>();
        java.util.Map<String, Integer> categoryMap = new java.util.HashMap<>();
        // Somar "45 un + 3,75 kg + 12 pct" num número só não significa nada:
        // o total é mostrado por unidade.
        java.util.Map<String, Double> porUnidade = new java.util.LinkedHashMap<>();

        if(cursor.moveToFirst()) {

            String columnName = cursor.getString(0);
            double columnAmount = CurrencyHelper.parseCurrency(cursor.getString(1), 0);
            double columnValue = CurrencyHelper.parseCurrency(cursor.getString(2), 0.0);
            double columnMinStock = CurrencyHelper.parseCurrency(cursor.getString(3), 0);
            String columnCategory = cursor.getString(4);

            if (columnAmount * columnValue > 0) {
                entries.add(new PieEntry((float) (columnAmount * columnValue), columnName));
            }

            higherAmoutProductText = "<b>Maior</b> quantidade no estoque: <b>" + columnName + " (" + CurrencyHelper.formatQuantity(columnAmount) + ")</b>";
            lowerAmoutProductText = "<b>Menor</b> quantidade no estoque: <b>" + columnName + " (" + CurrencyHelper.formatQuantity(columnAmount) + ")</b>";

            higherAmoutProductValue = columnAmount;
            lowerAmoutProductValue = columnAmount;
            
            totalItemsCount += columnAmount;
            totalValueSum += (columnAmount * columnValue);
            somarPorUnidade(porUnidade, cursor.getString(5), columnAmount);

            // Verificar estoque baixo
            if(columnAmount <= 0 || (columnMinStock > 0 && columnAmount <= columnMinStock)) {
                lowStockProducts.add(columnName + ": " + CurrencyHelper.formatQuantity(columnAmount)
                        + (columnMinStock > 0 ? " (mín. " + CurrencyHelper.formatQuantity(columnMinStock) + ")" : " (sem estoque)"));
            }

            // Contar por categoria
            if(columnCategory != null && !columnCategory.isEmpty() && !columnCategory.equals("null")) {
                categoryMap.put(columnCategory, categoryMap.getOrDefault(columnCategory, 0) + 1);
            }

            while (cursor.moveToNext()) {

                columnName = cursor.getString(0);
                columnAmount = CurrencyHelper.parseCurrency(cursor.getString(1), 0);
                columnValue = CurrencyHelper.parseCurrency(cursor.getString(2), 0.0);
                columnMinStock = CurrencyHelper.parseCurrency(cursor.getString(3), 0);
                columnCategory = cursor.getString(4);

                if(columnAmount > higherAmoutProductValue) {
                    higherAmoutProductValue = columnAmount;
                    higherAmoutProductText = "<b>Maior</b> quantidade no estoque: <b>" + columnName + " (" + CurrencyHelper.formatQuantity(columnAmount) + ")</b>";
                }

                if(columnAmount < lowerAmoutProductValue) {
                    lowerAmoutProductValue = columnAmount;
                    lowerAmoutProductText = "<b>Menor</b> quantidade no estoque: <b>" + columnName + " (" + CurrencyHelper.formatQuantity(columnAmount) + ")</b>";
                }

                if (columnAmount * columnValue > 0) {
                    entries.add(new PieEntry((float) (columnAmount * columnValue), columnName));
                }
                
                totalItemsCount += columnAmount;
                totalValueSum += (columnAmount * columnValue);
                somarPorUnidade(porUnidade, cursor.getString(5), columnAmount);

                // Verificar estoque baixo
                if(columnAmount <= 0 || (columnMinStock > 0 && columnAmount <= columnMinStock)) {
                    lowStockProducts.add(columnName + ": " + CurrencyHelper.formatQuantity(columnAmount)
                        + (columnMinStock > 0 ? " (mín. " + CurrencyHelper.formatQuantity(columnMinStock) + ")" : " (sem estoque)"));
                }

                // Contar por categoria
                if(columnCategory != null && !columnCategory.isEmpty() && !columnCategory.equals("null")) {
                    categoryMap.put(columnCategory, categoryMap.getOrDefault(columnCategory, 0) + 1);
                }

            }

        }

        // Atualizar estatísticas gerais
        totalProducts.setText("Total de Produtos: " + cursorCount);
        totalItems.setText("Itens em estoque: " + descreverPorUnidade(porUnidade, totalItemsCount));
        totalValue.setText(getString(R.string.report_total_value, CurrencyHelper.formatCurrency(this, totalValueSum)));
        
        // "Valor médio por produto" não ajudava ninguém a decidir nada; o que
        // o dono quer saber é quantos itens precisa repor.
        averageValue.setText("Produtos para repor: " + lowStockProducts.size());

        // Calcular valor total de entradas e saídas
        calculateEntryExitTotals();

        // Configurar gráfico. Fatias com quantidade zero não desenham nada —
        // o MPAndroidChart trata isso como dados válidos e deixa o card em
        // branco, então o estado vazio é um overlay próprio.
        if (entries.isEmpty()) {
            mostrarDistribuicaoVazia();
        } else {
            mostrarDistribuicaoGrafico();
            // Com dezenas de produtos, uma fatia por produto virava um arco-íris
            // ilegível com rótulos sobrepostos. Mostra as maiores quantidades e
            // agrupa o resto em "Outros"; os nomes vão para a legenda.
            entries = agruparFatias(entries, 6);
            PieDataSet dataSet = new PieDataSet(entries, "");
            dataSet.setColors(
                    ContextCompat.getColor(this, R.color.color_brand),
                    ContextCompat.getColor(this, R.color.color_success),
                    ContextCompat.getColor(this, R.color.color_warning),
                    ContextCompat.getColor(this, R.color.color_error),
                    ContextCompat.getColor(this, R.color.color_brand_dark),
                    ContextCompat.getColor(this, R.color.color_text_muted),
                    // sétima cor: a fatia "Outros" não pode repetir a primeira
                    ContextCompat.getColor(this, R.color.color_disabled_text)
            );
            dataSet.setValueTextSize(12f);
            dataSet.setValueTextColor(ContextCompat.getColor(this, R.color.color_text_on_brand));
            dataSet.setSliceSpace(2f);
            float totalFatias = 0f;
            for (PieEntry e : entries) totalFatias += e.getValue();
            final float minimoRotulo = totalFatias * 0.06f;
            dataSet.setValueFormatter(new com.github.mikephil.charting.formatter.ValueFormatter() {
                @Override
                public String getFormattedValue(float value) {
                    // Fatias finas ficam só na legenda: o rótulo dentro delas
                    // se sobrepunha ao vizinho.
                    return value < minimoRotulo ? "" : CurrencyHelper.formatCurrency(ReportsActivity.this, value);
                }
            });

            data = new PieData(dataSet);

            chart.setData(data);
            chart.setUsePercentValues(false);
            chart.getDescription().setEnabled(false);
            chart.setDrawEntryLabels(false);
            chart.setHoleRadius(38f);
            chart.setTransparentCircleRadius(42f);
            chart.setExtraOffsets(4f, 4f, 4f, 4f);
            com.github.mikephil.charting.components.Legend legend = chart.getLegend();
            legend.setEnabled(true);
            // Horizontal com quebra de linha: é o único modo em que a
            // biblioteca reserva a altura da legenda em vez de desenhá-la por
            // cima da pizza.
            legend.setVerticalAlignment(com.github.mikephil.charting.components.Legend.LegendVerticalAlignment.BOTTOM);
            legend.setHorizontalAlignment(com.github.mikephil.charting.components.Legend.LegendHorizontalAlignment.LEFT);
            legend.setOrientation(com.github.mikephil.charting.components.Legend.LegendOrientation.HORIZONTAL);
            legend.setDrawInside(false);
            legend.setWordWrapEnabled(true);
            legend.setTextSize(12f);
            legend.setTextColor(ContextCompat.getColor(this, R.color.color_text));
            legend.setXEntrySpace(12f);
            legend.setYEntrySpace(6f);
            legend.setFormSize(10f);
            chart.animateY(1000);
        }

        // Análise de estoque
        if(cursorCount > 0) {

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                higher.setText(Html.fromHtml(higherAmoutProductText, Html.FROM_HTML_MODE_LEGACY));
                lower.setText(Html.fromHtml(lowerAmoutProductText, Html.FROM_HTML_MODE_LEGACY));
            } else {
                higher.setText(Html.fromHtml(higherAmoutProductText));
                lower.setText(Html.fromHtml(lowerAmoutProductText));
            }

            // Alertas de estoque baixo
            if(!lowStockProducts.isEmpty()) {
                dividerLowStock.setVisibility(android.view.View.VISIBLE);
                lowStockWarning.setVisibility(android.view.View.VISIBLE);
                lowStockList.setVisibility(android.view.View.VISIBLE);
                
                lowStockWarning.setText("Alerta: " + lowStockProducts.size() + " produto(s) com estoque baixo");
                
                StringBuilder lowStockText = new StringBuilder();
                for(String product : lowStockProducts) {
                    lowStockText.append("• ").append(product).append("\n");
                }
                lowStockList.setText(lowStockText.toString().trim());
            }

            // Mostrar categorias se houver
            if(!categoryMap.isEmpty()) {
                categoryTitle.setVisibility(android.view.View.VISIBLE);
                categorySection.setVisibility(android.view.View.VISIBLE);
                
                StringBuilder categoryText = new StringBuilder();
                List<java.util.Map.Entry<String, Integer>> categorias = new ArrayList<>(categoryMap.entrySet());
                java.util.Collections.sort(categorias, (a, b) -> b.getValue().compareTo(a.getValue()));
                for(java.util.Map.Entry<String, Integer> entry : categorias) {
                    categoryText.append("• ").append(entry.getKey())
                        .append(": ").append(entry.getValue())
                        .append(" produto(s)\n");
                }
                categoriesList.setText(categoryText.toString().trim());
            }

        } else {

            higher.setText("Sem informações no momento.");
            lower.setText("");

        }

        } catch (Exception e) {
            Log.e("ReportsActivity", "Error generating report data", e);
            Toast.makeText(this, "Erro ao gerar relatório: " + e.getMessage(), Toast.LENGTH_LONG).show();
            showEmptyState();
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Exception e) {
                    Log.e("ReportsActivity", "Error closing cursor", e);
                }
            }
        }

    }

    /**
     * Garante que o banco de dados está disponível e aberto
     * Tenta inicializar se necessário
     */
    private boolean ensureDatabaseAvailable() {
        try {
            // Verificar se o banco já está disponível e aberto
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }

            // Se MainActivity.instance está disponível, tentar inicializar o banco
            if (MainActivity.instance != null) {
                Log.d("ReportsActivity", "Attempting to initialize database through MainActivity");
                MainActivity.instance.openOrCreateDB();
                
                // Verificar se a inicialização foi bem-sucedida
                if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                    Log.d("ReportsActivity", "Database initialized successfully");
                    return true;
                }
            }

            // Última tentativa: tentar abrir o banco de dados diretamente
            Log.d("ReportsActivity", "Attempting to open database directly");
            MainActivity.stock = LocalDb.open(this);
            
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                Log.d("ReportsActivity", "Database opened successfully");
                return true;
            }

            Log.e("ReportsActivity", "All attempts to open database failed");
            return false;

        } catch (Exception e) {
            Log.e("ReportsActivity", "Error ensuring database availability", e);
            return false;
        }
    }

    /**
     * Mostra um estado vazio quando não há dados ou há erro
     */
    private void showEmptyState() {
        try {
            String sym = CurrencyHelper.getCurrencySymbol(this);
            higher.setText("Sem informações disponíveis no momento.");
            lower.setText("");
            totalProducts.setText("Total de Produtos: 0");
            totalItems.setText("Total de Itens: 0");
            totalValue.setText(getString(R.string.report_total_value_zero, sym));
            averageValue.setText("Produtos para repor: 0");
            if (totalEntryValue != null) {
                totalEntryValue.setText(getString(R.string.total_entry_value_zero, sym));
            }
            if (totalExitValue != null) {
                totalExitValue.setText(getString(R.string.total_exit_value_zero, sym));
            }
            
            // Esconder avisos e seções opcionais
            if (dividerLowStock != null) {
                dividerLowStock.setVisibility(View.GONE);
            }
            if (lowStockWarning != null) {
                lowStockWarning.setVisibility(View.GONE);
            }
            if (lowStockList != null) {
                lowStockList.setVisibility(View.GONE);
            }
            if (categoryTitle != null) {
                categoryTitle.setVisibility(View.GONE);
            }
            if (categorySection != null) {
                categorySection.setVisibility(View.GONE);
            }
            
            // Limpar gráfico
            mostrarDistribuicaoVazia();
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error showing empty state", e);
        }
    }

    private void mostrarDistribuicaoVazia() {
        if (chart != null) {
            chart.clear();
            chart.setVisibility(View.GONE);
        }
        if (chartEmptyState != null) {
            chartEmptyState.setVisibility(View.VISIBLE);
        }
    }

    private void mostrarDistribuicaoGrafico() {
        if (chartEmptyState != null) {
            chartEmptyState.setVisibility(View.GONE);
        }
        if (chart != null) {
            chart.setVisibility(View.VISIBLE);
        }
    }

    /**
     * Calcula e exibe os valores totais de entradas e saídas a partir do
     * histórico de movimentações, multiplicando quantidade pelo valor
     * unitário atual do produto.
     */
    private void calculateEntryExitTotals() {
        double totalEntry = 0.0;
        double totalExit = 0.0;
        Cursor historyCursor = null;
        try {
            historyCursor = MainActivity.stock.rawQuery(
                "SELECT h.change_type, h.quantity, e.value " +
                "FROM EstoqueHistorico h " + LocalDb.JOIN_MOVEMENT_PRODUCT + " " +
                "WHERE h.deleted_at IS NULL",
                null);

            if (historyCursor.moveToFirst()) {
                do {
                    String changeType = historyCursor.getString(0);
                    double qty = CurrencyHelper.parseCurrency(historyCursor.getString(1), 0);
                    double unitVal = CurrencyHelper.parseCurrency(historyCursor.getString(2), 0.0);
                    double lineTotal = Math.abs(qty) * unitVal;

                    if (isEntrada(changeType, qty)) {
                        totalEntry += lineTotal;
                    } else if (isSaida(changeType, qty)) {
                        totalExit += lineTotal;
                    }
                } while (historyCursor.moveToNext());
            }
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error calculating entry/exit totals", e);
        } finally {
            if (historyCursor != null) {
                try { historyCursor.close(); } catch (Exception ignored) {}
            }
        }

        if (totalEntryValue != null) {
            totalEntryValue.setText(getString(R.string.total_entry_value,
                    CurrencyHelper.formatCurrency(this, totalEntry)));
        }
        if (totalExitValue != null) {
            totalExitValue.setText(getString(R.string.total_exit_value,
                    CurrencyHelper.formatCurrency(this, totalExit)));
        }
    }

    // Métodos de permissão
    private boolean checkPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+ não precisa de permissão para escrever em Downloads
            return true;
        } else {
            int result = ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE);
            return result == PackageManager.PERMISSION_GRANTED;
        }
    }

    private void requestPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            ActivityCompat.requestPermissions(this, 
                new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 
                PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                exportToPdf();
            } else {
                Toast.makeText(this, "Permissão negada. Não é possível exportar o PDF.", Toast.LENGTH_LONG).show();
            }
        }
    }

    /**
     * Ponto de entrada acionado pelos botões. Para relatórios baseados no
     * histórico exibe o seletor de período; para relatórios de inventário
     * (estoque baixo / categoria) exporta diretamente.
     */
    private void startReport(ReportType type) {
        if (needsPeriod(type)) {
            showPeriodDialog(type);
        } else {
            beginExport(type, Period.TUDO);
        }
    }

    /** Indica se o tipo de relatório usa o filtro de período (histórico). */
    private boolean needsPeriod(ReportType type) {
        return type == ReportType.COMPLETO
                || type == ReportType.MOVIMENTACOES
                || type == ReportType.SAIDAS
                || type == ReportType.ENTRADAS
                || type == ReportType.FINANCEIRO;
    }

    /** Exibe um diálogo para escolha do período pré-definido. */
    private void showPeriodDialog(final ReportType type) {
        final Period[] periods = Period.values();
        final String[] labels = new String[periods.length];
        for (int i = 0; i < periods.length; i++) {
            labels[i] = periods[i].getLabel();
        }

        // Pré-selecionar "Todo o período" por padrão.
        int defaultIndex = periods.length - 1;

        new AlertDialog.Builder(this)
                .setTitle("Selecione o período")
                .setSingleChoiceItems(labels, defaultIndex, null)
                .setPositiveButton("Gerar", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        int selected = ((AlertDialog) dialog).getListView().getCheckedItemPosition();
                        if (selected < 0 || selected >= periods.length) {
                            selected = periods.length - 1;
                        }
                        beginExport(type, periods[selected]);
                    }
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    /** Registra o tipo/período pendentes e dispara a exportação (com permissão). */
    private void beginExport(ReportType type, Period period) {
        pendingReportType = type;
        pendingPeriod = period;
        if (checkPermission()) {
            exportToPdf();
        } else {
            requestPermission();
        }
    }

    // Método principal de exportação de PDF.
    // A geração e gravação do arquivo é feita em uma thread de background
    // (Executor) para evitar ANR por I/O na main thread.
    private void exportToPdf() {
        if (isExportingPdf) {
            Toast.makeText(this, "Exportação já em andamento...", Toast.LENGTH_SHORT).show();
            return;
        }

        // Garantir banco disponível na main thread (pode exibir Toast/inicializar UI)
        if (!ensureDatabaseAvailable()) {
            Toast.makeText(this, "Erro: Banco de dados não disponível para exportação", Toast.LENGTH_LONG).show();
            Log.e("ReportsActivity", "Database is not available for PDF export");
            return;
        }

        isExportingPdf = true;

        // Mostrar indicador de progresso
        pdfProgressDialog = new android.app.ProgressDialog(this);
        pdfProgressDialog.setMessage("Gerando PDF, aguarde...");
        pdfProgressDialog.setCancelable(false);
        pdfProgressDialog.show();

        pdfExecutor.execute(() -> {
            File resultFile = null;
            String errorMessage = null;
            try {
                resultFile = buildAndWritePdf();
            } catch (SecurityException e) {
                Log.e("ReportsActivity", "Permission error exporting PDF", e);
                errorMessage = "Permissão negada ao salvar o PDF.";
            } catch (IOException e) {
                Log.e("ReportsActivity", "I/O error exporting PDF", e);
                errorMessage = "Erro de armazenamento ao salvar o PDF: " + e.getMessage();
            } catch (Exception e) {
                Log.e("ReportsActivity", "Error exporting PDF", e);
                errorMessage = "Erro ao exportar PDF: " + e.getMessage();
            }

            final File finalFile = resultFile;
            final String finalError = errorMessage;
            runOnUiThread(() -> {
                isExportingPdf = false;
                dismissPdfProgressDialog();

                if (isFinishing() || isDestroyed()) {
                    return;
                }

                if (finalFile != null) {
                    showPdfExportedDialog(finalFile);
                } else {
                    Toast.makeText(ReportsActivity.this,
                            finalError != null ? finalError : "Erro ao exportar PDF.",
                            Toast.LENGTH_LONG).show();
                }
            });
        });
    }

    private void dismissPdfProgressDialog() {
        try {
            if (pdfProgressDialog != null && pdfProgressDialog.isShowing()) {
                pdfProgressDialog.dismiss();
            }
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error dismissing progress dialog", e);
        } finally {
            pdfProgressDialog = null;
        }
    }

    /**
     * Gera o documento PDF e o grava no armazenamento. Executado em background.
     * @return o arquivo gerado
     * @throws Exception em caso de falha de banco, armazenamento ou escrita
     */
    private File buildAndWritePdf() throws Exception {
        ReportType type = pendingReportType != null ? pendingReportType : ReportType.COMPLETO;
        Period period = pendingPeriod != null ? pendingPeriod : Period.TUDO;

        // Criar o diretório de destino
        File pdfDir;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            pdfDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "EstoqueSimples");
        } else {
            pdfDir = new File(Environment.getExternalStorageDirectory(), "EstoqueSimples");
        }

        if (!pdfDir.exists() && !pdfDir.mkdirs()) {
            throw new IOException("Não foi possível criar a pasta de destino.");
        }

        // Criar nome do arquivo com data e hora
        String timeStamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.getDefault()).format(new Date());
        File pdfFile = new File(pdfDir, fileNamePrefix(type) + timeStamp + ".pdf");

        // Verificar se o banco de dados está disponível
        if (MainActivity.stock == null || !MainActivity.stock.isOpen()) {
            throw new IllegalStateException("Banco de dados não disponível para exportação");
        }

        PdfReportBuilder builder = new PdfReportBuilder();
        try {
            switch (type) {
                case MOVIMENTACOES:
                    buildMovementsReport(builder, period, null);
                    break;
                case SAIDAS:
                    buildMovementsReport(builder, period, Boolean.FALSE);
                    break;
                case ENTRADAS:
                    buildMovementsReport(builder, period, Boolean.TRUE);
                    break;
                case ESTOQUE_BAIXO:
                    buildLowStockReport(builder);
                    break;
                case CATEGORIA:
                    buildCategoryReport(builder);
                    break;
                case FINANCEIRO:
                    buildFinancialReport(builder, period);
                    break;
                case COMPLETO:
                default:
                    buildCompleteReport(builder, period);
                    break;
            }
            builder.footer();
            return builder.finish(pdfFile);
        } catch (Exception e) {
            builder.discard();
            throw e;
        }
    }

    /** Prefixo do nome de arquivo por tipo de relatório. */
    private String fileNamePrefix(ReportType type) {
        switch (type) {
            case MOVIMENTACOES:
                return "Relatorio_Movimentacoes_";
            case SAIDAS:
                return "Relatorio_Saidas_";
            case ENTRADAS:
                return "Relatorio_Entradas_";
            case ESTOQUE_BAIXO:
                return "Relatorio_EstoqueBaixo_";
            case CATEGORIA:
                return "Relatorio_Categoria_";
            case FINANCEIRO:
                return "Relatorio_Financeiro_";
            case COMPLETO:
            default:
                return "Relatorio_Completo_";
        }
    }

    // =====================================================================
    // Montagem do conteúdo de cada tipo de relatório
    // =====================================================================

    /** Relatório completo: inventário + movimentações + estoque baixo. */
    private void buildCompleteReport(PdfReportBuilder b, Period period) {
        b.title("RELATÓRIO COMPLETO DE ESTOQUE");
        b.subtitle("Gerado em: " + nowStr());
        b.subtitle("Período das movimentações: " + period.getLabel());
        b.spacer(8);

        drawInventorySummary(b);
        drawMovementFinancialSummary(b, period);
        drawLowStockSection(b);
        drawDetailedProductList(b);
        drawMovementsSection(b, period, null, "MOVIMENTAÇÕES NO PERÍODO");
    }

    /** Relatório de movimentações (todas, só entradas ou só saídas). */
    private void buildMovementsReport(PdfReportBuilder b, Period period, Boolean entradaFilter) {
        String title;
        String header;
        if (entradaFilter == null) {
            title = "RELATÓRIO DE MOVIMENTAÇÕES";
            header = "ENTRADAS E SAÍDAS";
        } else if (entradaFilter) {
            title = "RELATÓRIO DE ENTRADAS";
            header = "ENTRADAS";
        } else {
            title = "RELATÓRIO DE SAÍDAS";
            header = "SAÍDAS";
        }

        b.title(title);
        b.subtitle("Gerado em: " + nowStr());
        b.subtitle("Período: " + period.getLabel());
        b.spacer(8);

        if (entradaFilter == null) {
            drawMovementFinancialSummary(b, period);
        }
        drawMovementsSection(b, period, entradaFilter, header);
    }

    /** Relatório de estoque baixo. */
    private void buildLowStockReport(PdfReportBuilder b) {
        b.title("RELATÓRIO DE ESTOQUE BAIXO");
        b.subtitle("Gerado em: " + nowStr());
        b.spacer(10);
        drawLowStockSection(b);
    }

    /** Relatório de inventário agrupado por categoria com subtotais. */
    private void buildCategoryReport(PdfReportBuilder b) {
        b.title("RELATÓRIO POR CATEGORIA");
        b.subtitle("Gerado em: " + nowStr());
        b.spacer(10);

        Cursor c = null;
        try {
            c = MainActivity.stock.rawQuery(
                    "SELECT name, amount, value, category, unit FROM Estoque " +
                            "WHERE " + LocalDb.ACTIVE_PRODUCTS + " ORDER BY category COLLATE NOCASE, name COLLATE NOCASE",
                    null);

            if (c == null || !c.moveToFirst()) {
                b.text("Nenhum produto cadastrado.", 10);
                return;
            }

            String currentCat = null;
            double catItems = 0, catValue = 0;
            int catCount = 0;
            double grandItems = 0, grandValue = 0;
            int grandCount = 0;

            do {
                String name = c.getString(0);
                double amount = CurrencyHelper.parseCurrency(c.getString(1), 0);
                double value = CurrencyHelper.parseCurrency(c.getString(2), 0.0);
                String cat = c.getString(3);
                if (!present(cat)) {
                    cat = "Sem categoria";
                }
                String unit = unitSuffix(c.getString(4));

                if (currentCat == null || !currentCat.equals(cat)) {
                    if (currentCat != null) {
                        drawCategorySubtotal(b, catCount, catItems, catValue);
                    }
                    currentCat = cat;
                    catItems = 0;
                    catValue = 0;
                    catCount = 0;
                    b.heading(cat);
                }

                b.text("• " + name + " — " + fq(amount) + unit + " x " + fc(value)
                        + " = " + fc(amount * value), 10);

                catItems += amount;
                catValue += amount * value;
                catCount++;
                grandItems += amount;
                grandValue += amount * value;
                grandCount++;
            } while (c.moveToNext());

            drawCategorySubtotal(b, catCount, catItems, catValue);

            b.spacer(6);
            b.divider();
            b.label("TOTAL GERAL: " + grandCount + " produto(s), " + fq(grandItems)
                    + " itens, " + fc(grandValue), 10);
        } finally {
            closeCursor(c);
        }
    }

    /** Relatório financeiro: valores do inventário, top produtos e saldo. */
    private void buildFinancialReport(PdfReportBuilder b, Period period) {
        b.title("RELATÓRIO FINANCEIRO / VALOR DE INVENTÁRIO");
        b.subtitle("Gerado em: " + nowStr());
        b.subtitle("Período das movimentações: " + period.getLabel());
        b.spacer(8);

        drawInventorySummary(b);

        b.heading("PRODUTOS COM MAIOR VALOR EM ESTOQUE");
        Cursor c = null;
        try {
            c = MainActivity.stock.rawQuery("SELECT name, amount, value, unit FROM Estoque WHERE " + LocalDb.ACTIVE_PRODUCTS, null);
            List<ProductValue> list = new ArrayList<>();
            if (c != null && c.moveToFirst()) {
                do {
                    ProductValue pv = new ProductValue();
                    pv.name = c.getString(0);
                    pv.amount = CurrencyHelper.parseCurrency(c.getString(1), 0);
                    double value = CurrencyHelper.parseCurrency(c.getString(2), 0.0);
                    pv.unit = c.getString(3);
                    pv.totalValue = pv.amount * value;
                    list.add(pv);
                } while (c.moveToNext());
            }

            if (list.isEmpty()) {
                b.text("Nenhum produto cadastrado.", 10);
            } else {
                java.util.Collections.sort(list, new java.util.Comparator<ProductValue>() {
                    @Override
                    public int compare(ProductValue a, ProductValue z) {
                        return Double.compare(z.totalValue, a.totalValue);
                    }
                });
                int limit = Math.min(10, list.size());
                for (int i = 0; i < limit; i++) {
                    ProductValue pv = list.get(i);
                    b.text((i + 1) + ". " + pv.name + " — " + fq(pv.amount) + unitSuffix(pv.unit)
                            + " = " + fc(pv.totalValue), 10);
                }
            }
        } finally {
            closeCursor(c);
        }

        b.spacer(10);
        drawMovementFinancialSummary(b, period);
    }

    // =====================================================================
    // Seções reutilizáveis
    // =====================================================================

    /** RESUMO GERAL: total de produtos, itens, valor total e médio. */
    private void drawInventorySummary(PdfReportBuilder b) {
        b.heading("RESUMO GERAL");
        Cursor c = null;
        int totalProducts = 0;
        double totalItems = 0, totalValue = 0.0;
        try {
            c = MainActivity.stock.rawQuery("SELECT amount, value FROM Estoque WHERE " + LocalDb.ACTIVE_PRODUCTS, null);
            if (c != null) {
                totalProducts = c.getCount();
                if (c.moveToFirst()) {
                    do {
                        double amount = CurrencyHelper.parseCurrency(c.getString(0), 0);
                        double value = CurrencyHelper.parseCurrency(c.getString(1), 0.0);
                        totalItems += amount;
                        totalValue += (amount * value);
                    } while (c.moveToNext());
                }
            }
        } finally {
            closeCursor(c);
        }

        b.text("Total de Produtos: " + totalProducts, 10);
        b.text("Total de Itens: " + fq(totalItems), 10);
        b.text("Valor Total do Estoque: " + fc(totalValue), 10);
        if (totalProducts > 0) {
            b.text("Valor Médio por Produto: " + fc(totalValue / totalProducts), 10);
        }
        b.spacer(8);
    }

    /** RESUMO FINANCEIRO DE MOVIMENTAÇÕES: entradas, saídas e saldo no período. */
    private void drawMovementFinancialSummary(PdfReportBuilder b, Period period) {
        b.heading("RESUMO FINANCEIRO DE MOVIMENTAÇÕES");
        b.small("Período: " + period.getLabel(), 10);

        double totalEntry = 0.0, totalExit = 0.0;
        int entryCount = 0, exitCount = 0;
        Cursor c = null;
        try {
            c = MainActivity.stock.rawQuery(
                    "SELECT h.change_type, h.quantity, e.value " +
                            "FROM EstoqueHistorico h " + LocalDb.JOIN_MOVEMENT_PRODUCT + " " +
                            "WHERE h.timestamp >= ? AND h.deleted_at IS NULL",
                    new String[]{String.valueOf(period.cutoffMillis())});
            if (c != null && c.moveToFirst()) {
                do {
                    String changeType = c.getString(0);
                    double qty = CurrencyHelper.parseCurrency(c.getString(1), 0);
                    double val = CurrencyHelper.parseCurrency(c.getString(2), 0.0);
                    double line = Math.abs(qty) * val;
                    if (isEntrada(changeType, qty)) {
                        totalEntry += line;
                        entryCount++;
                    } else if (isSaida(changeType, qty)) {
                        totalExit += line;
                        exitCount++;
                    }
                } while (c.moveToNext());
            }
        } finally {
            closeCursor(c);
        }

        b.colored("Entradas (" + entryCount + "): " + fc(totalEntry), 10, true);
        b.colored("Saídas (" + exitCount + "): " + fc(totalExit), 10, false);
        b.label("Saldo (Entradas - Saídas): " + fc(totalEntry - totalExit), 10);
        b.small("* Valores estimados com o preço unitário atual dos produtos.", 10);
        b.spacer(8);
    }

    /** PRODUTOS COM ESTOQUE BAIXO: itens com amount <= min_stock. */
    private void drawLowStockSection(PdfReportBuilder b) {
        b.heading("PRODUTOS COM ESTOQUE BAIXO");
        Cursor c = null;
        int count = 0;
        try {
            c = MainActivity.stock.rawQuery(
                    "SELECT name, amount, min_stock, supplier, location, unit FROM Estoque " +
                            "WHERE " + LocalDb.ACTIVE_PRODUCTS + " ORDER BY name COLLATE NOCASE",
                    null);
            if (c != null && c.moveToFirst()) {
                do {
                    double amount = CurrencyHelper.parseCurrency(c.getString(1), 0);
                    double min = CurrencyHelper.parseCurrency(c.getString(2), 0);
                    if (min > 0 && amount <= min) {
                        count++;
                        String name = c.getString(0);
                        String supplier = c.getString(3);
                        String location = c.getString(4);
                        String unit = unitSuffix(c.getString(5));

                        b.itemTitle(count + ". " + name);
                        b.colored("Atual: " + fq(amount) + unit + "   |   Mínimo: "
                                + fq(min) + unit, 20, false);
                        double missing = min - amount;
                        if (missing < 0) missing = 0;
                        b.text("Faltam para o mínimo: " + fq(missing) + unit, 20);
                        if (present(supplier)) {
                            b.text("Fornecedor: " + supplier, 20);
                        }
                        if (present(location)) {
                            b.text("Localização: " + location, 20);
                        }
                        b.spacer(6);
                    }
                } while (c.moveToNext());
            }
        } finally {
            closeCursor(c);
        }

        if (count == 0) {
            b.text("Nenhum produto com estoque baixo no momento.", 10);
        } else {
            b.spacer(2);
            b.label("Total: " + count + " produto(s) para reposição.", 10);
        }
        b.spacer(8);
    }

    /** LISTA DETALHADA DE PRODUTOS. */
    private void drawDetailedProductList(PdfReportBuilder b) {
        b.heading("LISTA DETALHADA DE PRODUTOS");
        Cursor c = null;
        try {
            c = MainActivity.stock.rawQuery(
                    "SELECT name, description, amount, value, category, sku, barcode, supplier, location, min_stock, unit " +
                            "FROM Estoque WHERE " + LocalDb.ACTIVE_PRODUCTS + " ORDER BY name COLLATE NOCASE",
                    null);
            if (c == null || !c.moveToFirst()) {
                b.text("Nenhum produto cadastrado no momento.", 10);
                b.spacer(8);
                return;
            }

            int n = 1;
            do {
                String name = c.getString(0);
                String description = c.getString(1);
                double amount = CurrencyHelper.parseCurrency(c.getString(2), 0);
                double value = CurrencyHelper.parseCurrency(c.getString(3), 0.0);
                String category = c.getString(4);
                String sku = c.getString(5);
                String barcode = c.getString(6);
                String supplier = c.getString(7);
                String location = c.getString(8);
                String minStock = c.getString(9);
                String unit = c.getString(10);

                b.itemTitle(n + ". " + name);
                if (present(description)) {
                    b.small("Descrição: " + description, 20);
                }
                if (present(category)) {
                    b.text("Categoria: " + category, 20);
                }
                if (present(sku)) {
                    b.text("SKU: " + sku, 20);
                }
                if (present(barcode)) {
                    b.text("Código de Barras: " + barcode, 20);
                }
                b.text("Quantidade: " + fq(amount) + unitSuffix(unit), 20);
                b.text("Valor Unitário: " + fc(value), 20);
                b.label("Valor Total: " + fc(amount * value), 20);
                if (present(minStock)) {
                    double min = CurrencyHelper.parseCurrency(minStock, 0);
                    if (min > 0) {
                        b.text("Estoque Mínimo: " + fq(min) + unitSuffix(unit), 20);
                        if (amount <= min) {
                            b.colored("Status: ⚠ ESTOQUE BAIXO", 20, false);
                        }
                    }
                }
                if (present(supplier)) {
                    b.text("Fornecedor: " + supplier, 20);
                }
                if (present(location)) {
                    b.text("Localização: " + location, 20);
                }
                b.spacer(10);
                n++;
            } while (c.moveToNext());
        } finally {
            closeCursor(c);
        }
    }

    /**
     * Extrato de movimentações do histórico no período. entradaFilter:
     * null = todas, TRUE = só entradas, FALSE = só saídas.
     */
    private void drawMovementsSection(PdfReportBuilder b, Period period, Boolean entradaFilter, String header) {
        b.heading(header);
        b.small("Período: " + period.getLabel(), 10);

        SimpleDateFormat sdf = new SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault());
        Cursor c = null;
        int count = 0;
        double qtyEntrada = 0, qtySaida = 0, valEntrada = 0, valSaida = 0;
        try {
            c = MainActivity.stock.rawQuery(
                    "SELECT h.product_name, h.change_type, h.quantity, h.timestamp, h.note, e.value, e.unit " +
                            "FROM EstoqueHistorico h " + LocalDb.JOIN_MOVEMENT_PRODUCT + " " +
                            "WHERE h.timestamp >= ? AND h.deleted_at IS NULL ORDER BY h.timestamp DESC",
                    new String[]{String.valueOf(period.cutoffMillis())});
            if (c != null && c.moveToFirst()) {
                do {
                    String changeType = c.getString(1);
                    double qty = CurrencyHelper.parseCurrency(c.getString(2), 0);
                    boolean entrada = isEntrada(changeType, qty);
                    boolean saida = isSaida(changeType, qty);

                    if (entradaFilter != null) {
                        if (entradaFilter && !entrada) continue;
                        if (!entradaFilter && !saida) continue;
                    }

                    String product = c.getString(0);
                    long ts = c.getLong(3);
                    String note = c.getString(4);
                    double val = CurrencyHelper.parseCurrency(c.getString(5), 0.0);
                    String unit = unitSuffix(c.getString(6));
                    double absQty = Math.abs(qty);
                    double lineVal = absQty * val;

                    count++;
                    b.movementItem(count, sdf.format(new Date(ts)), product,
                            MovementDisplay.label(changeType),
                            fq(absQty) + unit, fc(lineVal), note, entrada);

                    if (entrada) {
                        qtyEntrada += absQty;
                        valEntrada += lineVal;
                    } else if (saida) {
                        qtySaida += absQty;
                        valSaida += lineVal;
                    }
                } while (c.moveToNext());
            }
        } finally {
            closeCursor(c);
        }

        if (count == 0) {
            b.text("Nenhuma movimentação no período selecionado.", 10);
            b.spacer(8);
            return;
        }

        b.spacer(4);
        b.divider();
        if (entradaFilter == null || entradaFilter) {
            b.colored("Total de entradas: " + fq(qtyEntrada) + " itens (" + fc(valEntrada) + ")", 10, true);
        }
        if (entradaFilter == null || !entradaFilter) {
            b.colored("Total de saídas: " + fq(qtySaida) + " itens (" + fc(valSaida) + ")", 10, false);
        }
        b.small("* Valores estimados com o preço unitário atual dos produtos.", 10);
        b.spacer(8);
    }

    private void drawCategorySubtotal(PdfReportBuilder b, int count, double items, double value) {
        b.small("Subtotal: " + count + " produto(s), " + fq(items) + " itens, " + fc(value), 12);
        b.spacer(6);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    private String nowStr() {
        return new SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.getDefault()).format(new Date());
    }

    private String fc(double value) {
        return CurrencyHelper.formatCurrency(this, value);
    }

    private String fq(double value) {
        return CurrencyHelper.formatQuantity(value);
    }

    private boolean present(String s) {
        return s != null && !s.isEmpty() && !s.equals("null");
    }

    private String unitSuffix(String unit) {
        return present(unit) ? " " + unit : "";
    }

    /**
     * Classifica a movimentação pelo efeito real no saldo.
     *
     * A lista fixa de tipos que existia aqui ignorava cadastro, importação,
     * edição e ajuste, então esses eventos sumiam dos relatórios — o total de
     * entradas não batia com o estoque que o usuário via na tela.
     */
    private boolean isEntrada(String changeType, double quantity) {
        return MovementRepository.signedQuantity(changeType, quantity) > 0;
    }

    private boolean isSaida(String changeType, double quantity) {
        return MovementRepository.signedQuantity(changeType, quantity) < 0;
    }

    private void closeCursor(Cursor c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception e) {
                Log.e("ReportsActivity", "Error closing cursor", e);
            }
        }
    }

    /** Estrutura auxiliar para ordenar produtos por valor em estoque. */
    private static class ProductValue {
        String name;
        String unit;
        double amount;
        double totalValue;
    }

    /**
     * Motor de desenho de PDF reutilizável: gerencia página A4, paginação,
     * paints e helpers de escrita (título, seção, texto, movimentações e rodapé).
     */
    private static class PdfReportBuilder {
        private final PdfDocument document = new PdfDocument();
        private final int pageWidth = 595;   // A4 width in points
        private final int pageHeight = 842;  // A4 height in points
        private final int margin = 40;
        private int yPosition;
        private int pageNumber = 0;
        private PdfDocument.Page page;
        private Canvas canvas;
        private boolean finished = false;

        private final Paint titlePaint = new Paint();
        private final Paint subtitlePaint = new Paint();
        private final Paint headingPaint = new Paint();
        private final Paint itemPaint = new Paint();
        private final Paint normalPaint = new Paint();
        private final Paint smallPaint = new Paint();
        private final Paint labelPaint = new Paint();
        private final Paint greenPaint = new Paint();
        private final Paint redPaint = new Paint();
        private final Paint footerPaint = new Paint();

        PdfReportBuilder() {
            titlePaint.setTextSize(22);
            titlePaint.setColor(Color.BLACK);
            titlePaint.setFakeBoldText(true);
            titlePaint.setTextAlign(Paint.Align.CENTER);
            titlePaint.setAntiAlias(true);

            subtitlePaint.setTextSize(10);
            subtitlePaint.setColor(Color.DKGRAY);
            subtitlePaint.setTextAlign(Paint.Align.CENTER);
            subtitlePaint.setAntiAlias(true);

            headingPaint.setTextSize(15);
            headingPaint.setColor(Color.parseColor("#1C679D"));
            headingPaint.setFakeBoldText(true);
            headingPaint.setAntiAlias(true);

            itemPaint.setTextSize(12);
            itemPaint.setColor(Color.BLACK);
            itemPaint.setFakeBoldText(true);
            itemPaint.setAntiAlias(true);

            normalPaint.setTextSize(11);
            normalPaint.setColor(Color.BLACK);
            normalPaint.setAntiAlias(true);

            smallPaint.setTextSize(9);
            smallPaint.setColor(Color.DKGRAY);
            smallPaint.setAntiAlias(true);

            labelPaint.setTextSize(11);
            labelPaint.setColor(Color.BLACK);
            labelPaint.setFakeBoldText(true);
            labelPaint.setAntiAlias(true);

            greenPaint.setTextSize(11);
            greenPaint.setColor(Color.parseColor("#2E7D32"));
            greenPaint.setFakeBoldText(true);
            greenPaint.setAntiAlias(true);

            redPaint.setTextSize(11);
            redPaint.setColor(Color.parseColor("#C62828"));
            redPaint.setFakeBoldText(true);
            redPaint.setAntiAlias(true);

            footerPaint.setTextSize(9);
            footerPaint.setColor(Color.DKGRAY);
            footerPaint.setTextAlign(Paint.Align.CENTER);
            footerPaint.setAntiAlias(true);

            newPage();
        }

        private void newPage() {
            if (page != null) {
                document.finishPage(page);
            }
            pageNumber++;
            PdfDocument.PageInfo info =
                    new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create();
            page = document.startPage(info);
            canvas = page.getCanvas();
            yPosition = margin + 20;
        }

        void ensureSpace(int needed) {
            if (yPosition + needed > pageHeight - 55) {
                newPage();
            }
        }

        void title(String text) {
            ensureSpace(30);
            canvas.drawText(text, pageWidth / 2f, yPosition, titlePaint);
            yPosition += 26;
        }

        void subtitle(String text) {
            ensureSpace(16);
            canvas.drawText(text, pageWidth / 2f, yPosition, subtitlePaint);
            yPosition += 15;
        }

        void heading(String text) {
            ensureSpace(34);
            yPosition += 6;
            canvas.drawText(text, margin, yPosition, headingPaint);
            yPosition += 8;
            canvas.drawLine(margin, yPosition, pageWidth - margin, yPosition, smallPaint);
            yPosition += 16;
        }

        void itemTitle(String text) {
            ensureSpace(22);
            canvas.drawText(truncateSingle(text, 70), margin, yPosition, itemPaint);
            yPosition += 16;
        }

        void text(String text, int indent) {
            wrappedText(text, normalPaint, indent);
        }

        void small(String text, int indent) {
            wrappedText(text, smallPaint, indent);
        }

        void label(String text, int indent) {
            wrappedText(text, labelPaint, indent);
        }

        void colored(String text, int indent, boolean green) {
            wrappedText(text, green ? greenPaint : redPaint, indent);
        }

        void divider() {
            ensureSpace(12);
            canvas.drawLine(margin, yPosition, pageWidth - margin, yPosition, smallPaint);
            yPosition += 10;
        }

        void spacer(int px) {
            yPosition += px;
            if (yPosition > pageHeight - 55) {
                newPage();
            }
        }

        void wrappedText(String text, Paint paint, int indent) {
            if (text == null) return;
            int lineHeight = (int) (paint.getTextSize() + 4);
            int maxWidth = pageWidth - margin - (margin + indent);
            if (maxWidth < 60) maxWidth = 60;
            String[] paras = text.split("\n", -1);
            for (String para : paras) {
                if (para.isEmpty()) {
                    yPosition += lineHeight;
                    continue;
                }
                String remaining = para;
                while (remaining.length() > 0) {
                    int count = paint.breakText(remaining, true, maxWidth, null);
                    if (count <= 0) count = 1;
                    ensureSpace(lineHeight);
                    canvas.drawText(remaining.substring(0, count), margin + indent, yPosition, paint);
                    yPosition += lineHeight;
                    remaining = remaining.substring(count);
                }
            }
        }

        void movementItem(int number, String date, String product, String typeLabel,
                           String qtyText, String valueText, String note, boolean entrada) {
            ensureSpace(60);
            canvas.drawText(number + ". " + truncateSingle(product, 60), margin, yPosition, itemPaint);
            yPosition += 15;
            canvas.drawText(typeLabel + "  •  " + date, margin + 12, yPosition, entrada ? greenPaint : redPaint);
            yPosition += 14;
            canvas.drawText("Quantidade: " + qtyText + "     Valor estimado: " + valueText,
                    margin + 12, yPosition, normalPaint);
            yPosition += 14;
            if (note != null && !note.trim().isEmpty() && !note.equals("null")) {
                canvas.drawText("Observações:", margin + 12, yPosition, labelPaint);
                yPosition += 13;
                wrappedText(note.trim(), smallPaint, 24);
            }
            yPosition += 8;
        }

        void footer() {
            int y = pageHeight - 30;
            canvas.drawLine(margin, y - 12, pageWidth - margin, y - 12, smallPaint);
            canvas.drawText("Relatório gerado pelo Estoque Simples", pageWidth / 2f, y, footerPaint);
        }

        File finish(File file) throws IOException {
            if (!finished) {
                if (page != null) {
                    document.finishPage(page);
                }
                finished = true;
            }
            try (FileOutputStream fos = new FileOutputStream(file)) {
                document.writeTo(fos);
            } finally {
                document.close();
            }
            return file;
        }

        void discard() {
            try {
                if (!finished && page != null) {
                    document.finishPage(page);
                }
            } catch (Exception ignored) {
            }
            try {
                document.close();
            } catch (Exception ignored) {
            }
            finished = true;
        }

        private static String truncateSingle(String text, int maxLength) {
            if (text == null) return "";
            if (text.length() <= maxLength) return text;
            return text.substring(0, Math.max(0, maxLength - 3)) + "...";
        }
    }

    // Mostrar dialog com opções após exportar o PDF
    private void showPdfExportedDialog(final File pdfFile) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Relatório em PDF pronto");
        builder.setMessage("Salvo em Downloads/EstoqueSimples/" + pdfFile.getName());
        builder.setIcon(android.R.drawable.ic_dialog_info);

        // Botão para visualizar o PDF
        builder.setPositiveButton("Abrir PDF", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                openPdfFile(pdfFile);
            }
        });

        // Fechar explícito: sem ele a única saída era o gesto de voltar.
        builder.setNeutralButton("Fechar", null);

        // Botão para compartilhar
        builder.setNegativeButton("Compartilhar", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                sharePdfFile(pdfFile);
            }
        });

        builder.show();
    }

    // Abrir o PDF com um visualizador
    private void openPdfFile(File pdfFile) {
        try {
            // Usar FileUriHelper para criar URI segura
            Uri pdfUri = FileUriHelper.getUriForFile(this, pdfFile);
            
            if (pdfUri == null) {
                Log.e("ReportsActivity", "Failed to create URI for PDF file");
                Toast.makeText(this, 
                    "Erro ao criar referência para o arquivo PDF.", 
                    Toast.LENGTH_LONG).show();
                return;
            }

            // Verificar se a URI é segura
            if (!FileUriHelper.isUriSafe(pdfUri)) {
                Log.e("ReportsActivity", "Created URI is not safe for sharing: " + pdfUri);
                Toast.makeText(this, 
                    "Erro de segurança ao abrir PDF.", 
                    Toast.LENGTH_LONG).show();
                return;
            }

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(pdfUri, "application/pdf");
            intent.setFlags(Intent.FLAG_ACTIVITY_NO_HISTORY);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            // Tentar abrir; em Android 11+ resolveActivity pode falhar por package
            // visibility mesmo havendo visualizador, então usamos try/catch.
            try {
                startActivity(intent);
            } catch (android.content.ActivityNotFoundException e) {
                Toast.makeText(this, 
                    "Nenhum aplicativo encontrado para abrir PDF.\nInstale um visualizador de PDF.", 
                    Toast.LENGTH_LONG).show();
            }
        } catch (android.os.FileUriExposedException e) {
            Log.e("ReportsActivity", "FileUriExposedException when opening PDF", e);
            Toast.makeText(this, 
                "Erro de segurança: Não é possível compartilhar arquivo diretamente.\nPor favor, atualize o aplicativo.", 
                Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error opening PDF file", e);
            Toast.makeText(this, 
                "Erro ao abrir PDF: " + e.getMessage(), 
                Toast.LENGTH_LONG).show();
        }
    }

    // Abrir o gerenciador de arquivos na pasta do PDF
    private void openFolder(File pdfFile) {
        try {
            Intent intent;
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+: abrir a pasta Downloads usando DocumentsProvider
                intent = new Intent(Intent.ACTION_VIEW);
                Uri uri = Uri.parse("content://com.android.externalstorage.documents/document/primary:Download/EstoqueSimples");
                intent.setDataAndType(uri, "vnd.android.document/directory");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                // Android 7-9: Não podemos abrir diretório diretamente, mostrar mensagem com caminho
                Toast.makeText(this, 
                    "Arquivo salvo em:\n" + pdfFile.getParentFile().getAbsolutePath() + 
                    "\n\nAbra seu gerenciador de arquivos e navegue até esta pasta.", 
                    Toast.LENGTH_LONG).show();
                return;
            } else {
                // Android 6 e inferior: pode usar URI de arquivo diretamente
                Uri selectedUri = FileUriHelper.getUriForDirectory(this, pdfFile.getParentFile());
                if (selectedUri == null) {
                    // Fallback: mostrar o caminho
                    Toast.makeText(this, 
                        "Arquivo salvo em:\n" + pdfFile.getParentFile().getAbsolutePath(), 
                        Toast.LENGTH_LONG).show();
                    return;
                }
                
                intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(selectedUri, "resource/folder");
                
                // Fallback: tentar com o DocumentsUI
                if (intent.resolveActivity(getPackageManager()) == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.setDataAndType(selectedUri, "*/*");
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                }
            }

            // Tentar abrir; resolveActivity pode falhar no Android 11+ por package
            // visibility, então tentamos abrir e caímos no fallback se não houver app.
            boolean opened = false;
            if (intent != null) {
                try {
                    startActivity(intent);
                    opened = true;
                } catch (android.content.ActivityNotFoundException e) {
                    opened = false;
                }
            }
            if (!opened) {
                // Se não conseguir abrir a pasta, mostrar o caminho
                Toast.makeText(this, 
                    "Arquivo salvo em:\n" + pdfFile.getParentFile().getAbsolutePath() + 
                    "\n\nAbra seu gerenciador de arquivos para localizar o arquivo.", 
                    Toast.LENGTH_LONG).show();
            }
        } catch (android.os.FileUriExposedException e) {
            Log.e("ReportsActivity", "FileUriExposedException when opening folder", e);
            Toast.makeText(this, 
                "Arquivo salvo em:\n" + pdfFile.getParentFile().getAbsolutePath() + 
                "\n\nAbra seu gerenciador de arquivos para localizar o arquivo.", 
                Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error opening folder", e);
            // Fallback: mostrar apenas o caminho
            Toast.makeText(this, 
                "Arquivo salvo em:\n" + pdfFile.getParentFile().getAbsolutePath(), 
                Toast.LENGTH_LONG).show();
        }
    }

    // Compartilhar o PDF
    private void sharePdfFile(File pdfFile) {
        try {
            // Usar FileUriHelper para criar URI segura
            Uri pdfUri = FileUriHelper.getUriForFile(this, pdfFile);
            
            if (pdfUri == null) {
                Log.e("ReportsActivity", "Failed to create URI for sharing PDF file");
                Toast.makeText(this, 
                    "Erro ao criar referência para o arquivo PDF.", 
                    Toast.LENGTH_LONG).show();
                return;
            }

            // Verificar se a URI é segura
            if (!FileUriHelper.isUriSafe(pdfUri)) {
                Log.e("ReportsActivity", "Created URI is not safe for sharing: " + pdfUri);
                Toast.makeText(this, 
                    "Erro de segurança ao compartilhar PDF.", 
                    Toast.LENGTH_LONG).show();
                return;
            }

            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType("application/pdf");
            shareIntent.putExtra(Intent.EXTRA_STREAM, pdfUri);
            shareIntent.putExtra(Intent.EXTRA_SUBJECT, "Relatório de Estoque");
            shareIntent.putExtra(Intent.EXTRA_TEXT, "Segue em anexo o relatório de estoque gerado pelo Estoque Simples.");
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            // O chooser sempre resolve quando há apps; usamos try/catch para
            // cobrir o caso (raro) de nenhum app de compartilhamento disponível.
            try {
                startActivity(Intent.createChooser(shareIntent, "Compartilhar PDF via:"));
            } catch (android.content.ActivityNotFoundException e) {
                Toast.makeText(this, 
                    "Nenhum aplicativo disponível para compartilhar arquivos.", 
                    Toast.LENGTH_LONG).show();
            }
        } catch (android.os.FileUriExposedException e) {
            Log.e("ReportsActivity", "FileUriExposedException when sharing PDF", e);
            Toast.makeText(this, 
                "Erro de segurança: Não é possível compartilhar arquivo diretamente.\nPor favor, atualize o aplicativo.", 
                Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error sharing PDF file", e);
            Toast.makeText(this, 
                "Erro ao compartilhar PDF: " + e.getMessage(), 
                Toast.LENGTH_LONG).show();
        }
    }

}
