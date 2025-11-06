package br.com.gameloop.estoquesimples;

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
import androidx.appcompat.app.AppCompatActivity;
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

import com.github.mikephil.charting.charts.PieChart;
import com.github.mikephil.charting.data.PieData;
import com.github.mikephil.charting.data.PieDataSet;
import com.github.mikephil.charting.data.PieEntry;
import com.github.mikephil.charting.utils.ColorTemplate;

public class ReportsActivity extends AppCompatActivity {

    private static final int PERMISSION_REQUEST_CODE = 100;

    private PieChart chart;
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
    private TextView lowStockWarning;
    private TextView lowStockList;
    private TextView categoriesList;
    private TextView categoryTitle;
    private View categorySection;
    private View dividerLowStock;
    private Button btnExportPdf;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        try {
            setContentView(R.layout.activity_reports);

            if (getSupportActionBar() != null) {
                getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            }

            // Inicializar views de forma segura
            chart = (PieChart) findViewById(R.id.chart);
            higher = (TextView) findViewById(R.id.higher);
            lower = (TextView) findViewById(R.id.lower);
            totalProducts = (TextView) findViewById(R.id.totalProducts);
            totalItems = (TextView) findViewById(R.id.totalItems);
            totalValue = (TextView) findViewById(R.id.totalValue);
            averageValue = (TextView) findViewById(R.id.averageValue);
            lowStockWarning = (TextView) findViewById(R.id.lowStockWarning);
            lowStockList = (TextView) findViewById(R.id.lowStockList);
            categoriesList = (TextView) findViewById(R.id.categoriesList);
            categoryTitle = (TextView) findViewById(R.id.categoryTitle);
            categorySection = findViewById(R.id.categorySection);
            dividerLowStock = findViewById(R.id.dividerLowStock);
            btnExportPdf = (Button) findViewById(R.id.btnExportPdf);

            // Verificar se os campos obrigatórios foram inicializados
            if (!areFieldsInitialized()) {
                Log.e("ReportsActivity", "Critical fields not initialized");
                Toast.makeText(this, "Erro ao carregar interface. Por favor, reinicie o aplicativo.", Toast.LENGTH_LONG).show();
                finish();
                return;
            }

            generateData();

        // Configurar botão de exportação de PDF
        btnExportPdf.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (checkPermission()) {
                    exportToPdf();
                } else {
                    requestPermission();
                }
            }
        });

        // Configurar e mostrar MREC do Appodeal com AdManager
        initializeAppodealAds();

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

    /**
     * Inicializa e exibe os anúncios usando AdManager
     */
    private void initializeAppodealAds() {
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, R.id.appodealMrecView);
        }
    }
    
    @Override
    protected void onResume() {
        super.onResume();
        // Atualizar anúncios baseado no status premium
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, R.id.appodealMrecView);
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.reports_menu, menu);
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
        } else if (itemId == R.id.menu_go_pro) {
            showProActivity();
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
            exitApp();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
    
    private void showProActivity() {
        Intent intent = new Intent(this, ProActivity.class);
        startActivity(intent);
    }
    
    private void exitApp() {
        new AlertDialog.Builder(this)
                .setTitle("Sair")
                .setMessage("Tem certeza que deseja sair do aplicativo?")
                .setPositiveButton("Sim", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int which) {
                        finishAffinity();
                    }
                })
                .setNegativeButton("Não", null)
                .show();
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
            cursor = MainActivity.stock.rawQuery("SELECT name, amount, value, min_stock, category FROM Estoque", null);

        int cursorCount = cursor.getCount();
        double totalItemsCount = 0;
        double totalValueSum = 0.0;
        List<String> lowStockProducts = new ArrayList<>();
        java.util.Map<String, Integer> categoryMap = new java.util.HashMap<>();

        if(cursor.moveToFirst()) {

            String columnName = cursor.getString(0);
            double columnAmount = parseWithDefault(cursor.getString(1), 0);
            double columnValue = parseDoubleWithDefault(cursor.getString(2), 0.0);
            double columnMinStock = parseWithDefault(cursor.getString(3), 0);
            String columnCategory = cursor.getString(4);

            entries.add(new PieEntry((float)columnAmount, columnName));

            higherAmoutProductText = "<b>Maior</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";
            lowerAmoutProductText = "<b>Menor</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";

            higherAmoutProductValue = columnAmount;
            lowerAmoutProductValue = columnAmount;
            
            totalItemsCount += columnAmount;
            totalValueSum += (columnAmount * columnValue);

            // Verificar estoque baixo
            if(columnMinStock > 0 && columnAmount <= columnMinStock) {
                lowStockProducts.add(columnName + " (" + columnAmount + "/" + columnMinStock + ")");
            }

            // Contar por categoria
            if(columnCategory != null && !columnCategory.isEmpty() && !columnCategory.equals("null")) {
                categoryMap.put(columnCategory, categoryMap.getOrDefault(columnCategory, 0) + 1);
            }

            while (cursor.moveToNext()) {

                columnName = cursor.getString(0);
                columnAmount = parseWithDefault(cursor.getString(1), 0);
                columnValue = parseDoubleWithDefault(cursor.getString(2), 0.0);
                columnMinStock = parseWithDefault(cursor.getString(3), 0);
                columnCategory = cursor.getString(4);

                if(columnAmount > higherAmoutProductValue) {
                    higherAmoutProductValue = columnAmount;
                    higherAmoutProductText = "<b>Maior</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";
                }

                if(columnAmount < lowerAmoutProductValue) {
                    lowerAmoutProductValue = columnAmount;
                    lowerAmoutProductText = "<b>Menor</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";
                }

                entries.add(new PieEntry((float)columnAmount, columnName));
                
                totalItemsCount += columnAmount;
                totalValueSum += (columnAmount * columnValue);

                // Verificar estoque baixo
                if(columnMinStock > 0 && columnAmount <= columnMinStock) {
                    lowStockProducts.add(columnName + " (" + columnAmount + "/" + columnMinStock + ")");
                }

                // Contar por categoria
                if(columnCategory != null && !columnCategory.isEmpty() && !columnCategory.equals("null")) {
                    categoryMap.put(columnCategory, categoryMap.getOrDefault(columnCategory, 0) + 1);
                }

            }

        }

        // Atualizar estatísticas gerais
        totalProducts.setText("Total de Produtos: " + cursorCount);
        totalItems.setText("Total de Itens: " + totalItemsCount);
        totalValue.setText(String.format("Valor Total: $%.2f", totalValueSum));
        
        if(cursorCount > 0) {
            double avgValue = totalValueSum / cursorCount;
            averageValue.setText(String.format("Valor Médio por Produto: $%.2f", avgValue));
        } else {
            averageValue.setText("Valor Médio: $0.00");
        }

        // Configurar gráfico
        PieDataSet dataSet = new PieDataSet(entries, "Produtos");
        dataSet.setColors(ColorTemplate.MATERIAL_COLORS);
        dataSet.setValueTextSize(12f);

        data = new PieData(dataSet);
        
        chart.setData(data);
        chart.setUsePercentValues(false);
        chart.getDescription().setEnabled(false);
        chart.setDrawEntryLabels(true);
        chart.setEntryLabelTextSize(11f);
        chart.animateY(1000);

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
                
                lowStockWarning.setText("⚠ Alerta: " + lowStockProducts.size() + " produto(s) com estoque baixo");
                
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
                for(java.util.Map.Entry<String, Integer> entry : categoryMap.entrySet()) {
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
            MainActivity.stock = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
            
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
            higher.setText("Sem informações disponíveis no momento.");
            lower.setText("");
            totalProducts.setText("Total de Produtos: 0");
            totalItems.setText("Total de Itens: 0");
            totalValue.setText("Valor Total: $0.00");
            averageValue.setText("Valor Médio: $0.00");
            
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
            if (chart != null) {
                chart.clear();
                chart.setNoDataText("Nenhum dado disponível");
                chart.invalidate();
            }
        } catch (Exception e) {
            Log.e("ReportsActivity", "Error showing empty state", e);
        }
    }

    public static double parseWithDefault(String number, double defaultVal) {
        try {
            if(number == null || number.isEmpty() || number.equals("null")) {
                return defaultVal;
            }
            return Double.parseDouble(number);
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }

    public static double parseDoubleWithDefault(String number, double defaultVal) {
        try {
            if(number == null || number.isEmpty() || number.equals("null")) {
                return defaultVal;
            }
            // Remover símbolos de moeda e espaços
            number = number.replace("$", "").replace(",", ".").trim();
            return Double.parseDouble(number);
        } catch (NumberFormatException e) {
            return defaultVal;
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

    // Método principal de exportação de PDF usando API nativa do Android
    private void exportToPdf() {
        try {
            // Criar o diretório de destino
            File pdfDir;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                pdfDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "EstoqueSimples");
            } else {
                pdfDir = new File(Environment.getExternalStorageDirectory(), "EstoqueSimples");
            }
            
            if (!pdfDir.exists()) {
                pdfDir.mkdirs();
            }

            // Criar nome do arquivo com data e hora
            String timeStamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.getDefault()).format(new Date());
            String fileName = "Relatorio_Estoque_" + timeStamp + ".pdf";
            File pdfFile = new File(pdfDir, fileName);

            // Criar o documento PDF
            PdfDocument pdfDocument = new PdfDocument();
            
            // Verificar se o banco de dados está disponível
            if (!ensureDatabaseAvailable()) {
                Toast.makeText(this, "Erro: Banco de dados não disponível para exportação", Toast.LENGTH_LONG).show();
                Log.e("ReportsActivity", "Database is not available for PDF export");
                return;
            }
            
            // Buscar dados do banco
            Cursor cursor = null;
            try {
                cursor = MainActivity.stock.rawQuery(
                    "SELECT name, description, amount, value, category, sku, barcode, supplier, location, min_stock, unit FROM Estoque", 
                    null
                );
            } catch (Exception e) {
                Log.e("ReportsActivity", "Error querying database for PDF export", e);
                Toast.makeText(this, "Erro ao acessar banco de dados: " + e.getMessage(), Toast.LENGTH_LONG).show();
                pdfDocument.close();
                return;
            }

            if (cursor == null) {
                Log.e("ReportsActivity", "Cursor is null after query");
                Toast.makeText(this, "Erro ao buscar dados do banco", Toast.LENGTH_LONG).show();
                pdfDocument.close();
                return;
            }

            int totalProducts = cursor.getCount();
            double totalItems = 0;
            double totalValue = 0.0;

            // Calcular totais
            if (cursor.moveToFirst()) {
                do {
                    double amount = parseWithDefault(cursor.getString(2), 0);
                    double value = parseDoubleWithDefault(cursor.getString(3), 0.0);
                    totalItems += amount;
                    totalValue += (amount * value);
                } while (cursor.moveToNext());
            }

            // Configurar paints
            Paint titlePaint = new Paint();
            titlePaint.setTextSize(24);
            titlePaint.setColor(Color.BLACK);
            titlePaint.setTextAlign(Paint.Align.CENTER);
            titlePaint.setFakeBoldText(true);

            Paint headingPaint = new Paint();
            headingPaint.setTextSize(16);
            headingPaint.setColor(Color.BLACK);
            headingPaint.setFakeBoldText(true);

            Paint normalPaint = new Paint();
            normalPaint.setTextSize(12);
            normalPaint.setColor(Color.BLACK);

            Paint smallPaint = new Paint();
            smallPaint.setTextSize(10);
            smallPaint.setColor(Color.DKGRAY);

            Paint labelPaint = new Paint();
            labelPaint.setTextSize(11);
            labelPaint.setColor(Color.BLACK);
            labelPaint.setFakeBoldText(true);

            // Largura e altura da página
            int pageWidth = 595; // A4 width in points
            int pageHeight = 842; // A4 height in points
            int margin = 40;
            int yPosition = margin + 30;
            int pageNumber = 1;

            // Criar primeira página
            PdfDocument.PageInfo pageInfo = new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create();
            PdfDocument.Page page = pdfDocument.startPage(pageInfo);
            Canvas canvas = page.getCanvas();

            // Título
            canvas.drawText("RELATÓRIO DE ESTOQUE", pageWidth / 2, yPosition, titlePaint);
            yPosition += 30;

            // Data de geração
            String dateStr = new SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.getDefault()).format(new Date());
            canvas.drawText("Gerado em: " + dateStr, pageWidth / 2, yPosition, smallPaint);
            yPosition += 40;

            // Resumo Geral
            canvas.drawText("RESUMO GERAL", margin, yPosition, headingPaint);
            yPosition += 25;

            canvas.drawText("Total de Produtos: " + totalProducts, margin + 10, yPosition, normalPaint);
            yPosition += 20;
            canvas.drawText("Total de Itens: " + totalItems, margin + 10, yPosition, normalPaint);
            yPosition += 20;
            canvas.drawText("Valor Total: " + String.format(Locale.getDefault(), "R$ %.2f", totalValue), margin + 10, yPosition, normalPaint);
            yPosition += 20;
            if (totalProducts > 0) {
                canvas.drawText("Valor Médio por Produto: " + String.format(Locale.getDefault(), "R$ %.2f", totalValue / totalProducts), margin + 10, yPosition, normalPaint);
                yPosition += 20;
            }
            yPosition += 20;

            // Lista detalhada de produtos
            if (totalProducts > 0) {
                canvas.drawText("LISTA DETALHADA DE PRODUTOS", margin, yPosition, headingPaint);
                yPosition += 30;

                cursor.moveToPosition(-1);
                int productNumber = 1;

                while (cursor.moveToNext()) {
                    // Verificar se precisa de nova página
                    if (yPosition > pageHeight - 100) {
                        pdfDocument.finishPage(page);
                        pageNumber++;
                        pageInfo = new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create();
                        page = pdfDocument.startPage(pageInfo);
                        canvas = page.getCanvas();
                        yPosition = margin + 30;
                    }

                    String name = cursor.getString(0);
                    String description = cursor.getString(1);
                    String category = cursor.getString(4);
                    String sku = cursor.getString(5);
                    String barcode = cursor.getString(6);
                    String supplier = cursor.getString(7);
                    String location = cursor.getString(8);
                    String minStock = cursor.getString(9);
                    String unit = cursor.getString(10);
                    double amount = parseWithDefault(cursor.getString(2), 0);
                    double value = parseDoubleWithDefault(cursor.getString(3), 0.0);

                    // Nome do produto
                    canvas.drawText(productNumber + ". " + truncateText(name, 60), margin, yPosition, headingPaint);
                    yPosition += 20;

                    // Descrição
                    if (description != null && !description.isEmpty() && !description.equals("null")) {
                        canvas.drawText("Descrição: " + truncateText(description, 50), margin + 20, yPosition, smallPaint);
                        yPosition += 15;
                    }

                    // Categoria
                    if (category != null && !category.isEmpty() && !category.equals("null")) {
                        canvas.drawText("Categoria: " + category, margin + 20, yPosition, normalPaint);
                        yPosition += 15;
                    }

                    // SKU
                    if (sku != null && !sku.isEmpty() && !sku.equals("null")) {
                        canvas.drawText("SKU: " + sku, margin + 20, yPosition, normalPaint);
                        yPosition += 15;
                    }

                    // Código de Barras
                    if (barcode != null && !barcode.isEmpty() && !barcode.equals("null")) {
                        canvas.drawText("Código de Barras: " + barcode, margin + 20, yPosition, normalPaint);
                        yPosition += 15;
                    }

                    // Quantidade
                    String amountStr = "Quantidade: " + amount;
                    if (unit != null && !unit.isEmpty() && !unit.equals("null")) {
                        amountStr += " " + unit;
                    }
                    canvas.drawText(amountStr, margin + 20, yPosition, normalPaint);
                    yPosition += 15;

                    // Valor Unitário
                    canvas.drawText("Valor Unitário: " + String.format(Locale.getDefault(), "R$ %.2f", value), margin + 20, yPosition, normalPaint);
                    yPosition += 15;

                    // Valor Total
                    canvas.drawText("Valor Total: " + String.format(Locale.getDefault(), "R$ %.2f", amount * value), margin + 20, yPosition, labelPaint);
                    yPosition += 15;

                    // Estoque Mínimo
                    if (minStock != null && !minStock.isEmpty() && !minStock.equals("null")) {
                        double minStockDouble = parseWithDefault(minStock, 0);
                        if (minStockDouble > 0) {
                            canvas.drawText("Estoque Mínimo: " + minStockDouble, margin + 20, yPosition, normalPaint);
                            yPosition += 15;
                            if (amount <= minStockDouble) {
                                Paint warningPaint = new Paint(normalPaint);
                                warningPaint.setColor(Color.RED);
                                canvas.drawText("Status: ⚠ ESTOQUE BAIXO", margin + 20, yPosition, warningPaint);
                                yPosition += 15;
                            }
                        }
                    }

                    // Fornecedor
                    if (supplier != null && !supplier.isEmpty() && !supplier.equals("null")) {
                        canvas.drawText("Fornecedor: " + truncateText(supplier, 50), margin + 20, yPosition, normalPaint);
                        yPosition += 15;
                    }

                    // Localização
                    if (location != null && !location.isEmpty() && !location.equals("null")) {
                        canvas.drawText("Localização: " + location, margin + 20, yPosition, normalPaint);
                        yPosition += 15;
                    }

                    yPosition += 15; // Espaço entre produtos
                    productNumber++;
                }
            } else {
                canvas.drawText("Nenhum produto cadastrado no momento.", pageWidth / 2, yPosition, normalPaint);
            }

            // Fechar cursor no finally
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Exception e) {
                    Log.e("ReportsActivity", "Error closing cursor in PDF export", e);
                }
            }

            // Adicionar rodapé na última página
            if (yPosition > pageHeight - 80) {
                pdfDocument.finishPage(page);
                pageNumber++;
                pageInfo = new PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create();
                page = pdfDocument.startPage(pageInfo);
                canvas = page.getCanvas();
                yPosition = margin + 30;
            }

            yPosition = pageHeight - 60;
            canvas.drawLine(margin, yPosition, pageWidth - margin, yPosition, smallPaint);
            yPosition += 15;
            canvas.drawText("Relatório gerado pelo Estoque Simples", pageWidth / 2, yPosition, smallPaint);
            yPosition += 15;
            canvas.drawText("© 2025 GameLoop", pageWidth / 2, yPosition, smallPaint);

            pdfDocument.finishPage(page);

            // Salvar o PDF
            try (FileOutputStream fos = new FileOutputStream(pdfFile)) {
                pdfDocument.writeTo(fos);
            }
            pdfDocument.close();

            // Mostrar dialog com opções após exportação bem-sucedida
            showPdfExportedDialog(pdfFile);
            
            // Registrar interação para contagem de anúncios
            AdManager.getInstance(this).registerInteraction(this);

        } catch (Exception e) {
            e.printStackTrace();
            Toast.makeText(this, 
                "Erro ao exportar PDF: " + e.getMessage(), 
                Toast.LENGTH_LONG).show();
        }
    }

    // Mostrar dialog com opções após exportar o PDF
    private void showPdfExportedDialog(final File pdfFile) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("PDF Exportado com Sucesso!");
        builder.setMessage("O relatório foi salvo em:\n" + pdfFile.getAbsolutePath());
        builder.setIcon(android.R.drawable.ic_dialog_info);

        // Botão para visualizar o PDF
        builder.setPositiveButton("Visualizar PDF", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                openPdfFile(pdfFile);
            }
        });

        // Botão para abrir a pasta
        builder.setNeutralButton("Abrir Pasta", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                openFolder(pdfFile);
            }
        });

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

            // Verificar se existe um app para abrir PDF
            if (intent.resolveActivity(getPackageManager()) != null) {
                startActivity(intent);
            } else {
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

            // Tentar abrir
            if (intent != null && intent.resolveActivity(getPackageManager()) != null) {
                startActivity(intent);
            } else {
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

            // Verificar se há apps para compartilhar
            if (shareIntent.resolveActivity(getPackageManager()) != null) {
                startActivity(Intent.createChooser(shareIntent, "Compartilhar PDF via:"));
            } else {
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

    // Método auxiliar para truncar texto
    private String truncateText(String text, int maxLength) {
        if (text == null) return "";
        if (text.length() <= maxLength) return text;
        return text.substring(0, maxLength - 3) + "...";
    }

}
