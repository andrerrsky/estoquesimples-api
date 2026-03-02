package br.com.gameloop.estoquesimples;

import android.Manifest;
import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import android.text.Html;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class ImportActivity extends AppCompatActivity {

    private TextView status;
    private TextView importDesc2;
    private TextView importExportDesc;
    private String statusText;

    // Constantes
    private static final String TAG = "ImportActivity";
    private static final String LOG_PREFIX = "Log:\n\n";

    // ActivityResultLaunchers para importar/exportar arquivos
    private ActivityResultLauncher<Intent> importFileLauncher;
    private ActivityResultLauncher<Intent> importDBLauncher;
    private ActivityResultLauncher<Intent> exportDBLauncher;
    private ActivityResultLauncher<Intent> exportCSVLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_import);

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        // Inicializar campos com verificação de erro
        status = findViewById(R.id.importStatus);
        importDesc2 = findViewById(R.id.importDesc2);
        importExportDesc = findViewById(R.id.importExportDesc);

        // Verificar se os campos foram inicializados
        if (status == null) {
            Log.e(TAG, "Failed to initialize status from layout");
        }
        if (importDesc2 == null) {
            Log.e(TAG, "Failed to initialize importDesc2 from layout");
        }
        if (importExportDesc == null) {
            Log.e(TAG, "Failed to initialize importExportDesc from layout");
        }

        // Verificar se algum campo obrigatório falhou
        if (!areFieldsInitialized()) {
            Toast.makeText(this, "Erro ao carregar interface. Por favor, reinicie o aplicativo.", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Critical fields not initialized, closing activity");
            finish();
            return;
        }

        statusText = LOG_PREFIX;

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            importDesc2.setText(Html.fromHtml("<b>Formato CSV/TXT (12 campos separados por vírgula):</b><br>" +
                    "Nome, Descrição, Quantidade, Valor, Foto, Categoria, SKU, Código de Barras, Fornecedor, Localização, Estoque Mínimo, Unidade<br>" +
                    "Sendo <b>1</b> produto por linha<br>" +
                    "Use vírgulas simples como separador<br>" +
                    "Campos vazios devem ser representados por espaço ou texto vazio entre vírgulas" , Html.FROM_HTML_MODE_LEGACY));
        } else {
            importDesc2.setText(Html.fromHtml("<b>Formato CSV/TXT (12 campos separados por vírgula):</b><br>" +
                    "Nome, Descrição, Quantidade, Valor, Foto, Categoria, SKU, Código de Barras, Fornecedor, Localização, Estoque Mínimo, Unidade<br>" +
                    "Sendo <b>1</b> produto por linha<br>" +
                    "Use vírgulas simples como separador<br>" +
                    "Campos vazios devem ser representados por espaço ou texto vazio entre vírgulas"));
        }

        // Inicializar launchers
        initializeActivityResultLaunchers();

        showImportMessage();

        // Configurar e mostrar MREC do Appodeal com AdManager
        initializeAppodealAds();

    }
    
    /**
     * Inicializa e exibe os anúncios usando AdManager
     */
    private void initializeAppodealAds() {
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, 0, R.id.appodealMrecView);
        }
    }

    /**
     * Verifica se todos os campos obrigatórios foram inicializados
     * @return true se todos os campos obrigatórios não são null
     */
    private boolean areFieldsInitialized() {
        if (status == null) {
            Log.e(TAG, "status is null");
            return false;
        }
        if (importDesc2 == null) {
            Log.e(TAG, "importDesc2 is null");
            return false;
        }
        if (importExportDesc == null) {
            Log.e(TAG, "importExportDesc is null");
            return false;
        }
        return true;
    }

    /**
     * Define o texto no campo importExportDesc de forma segura
     * @param text o texto a ser definido
     */
    private void setImportExportDescText(String text) {
        if (importExportDesc != null) {
            importExportDesc.setText(text);
        } else {
            Log.e(TAG, "importExportDesc field is null, cannot set text: " + text);
        }
    }
    
    @Override
    protected void onResume() {
        super.onResume();
        // Atualizar anúncios baseado no status premium
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, 0, R.id.appodealMrecView);
        }
    }

    /**
     * Inicializa os launchers para importar e exportar arquivos
     */
    private void initializeActivityResultLaunchers() {
        // Launcher para importar arquivo de texto/CSV
        importFileLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Uri uri = result.getData().getData();
                    if (uri != null) {
                        handleFileImport(uri);
                    }
                }
            }
        );

        // Launcher para importar banco de dados
        importDBLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Uri uri = result.getData().getData();
                    if (uri != null) {
                        handleDBImport(uri);
                    }
                }
            }
        );

        // Launcher para exportar banco de dados
        exportDBLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Uri uri = result.getData().getData();
                    if (uri != null) {
                        handleDBExport(uri);
                    }
                }
            }
        );

        // Launcher para exportar CSV
        exportCSVLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Uri uri = result.getData().getData();
                    if (uri != null) {
                        handleCSVExport(uri);
                    }
                }
            }
        );

    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.options_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        } else if (item.getItemId() == R.id.menu_about) {
            Intent intent = new Intent(this, AboutActivity.class);
            startActivity(intent);
            return true;
        } else if (item.getItemId() == R.id.menu_history) {
            Intent intent = new Intent(this, HistoryActivity.class);
            startActivity(intent);
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    public void importFile(View v) {
        statusText = "";

        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        String[] mimeTypes = {"text/plain", "text/csv", "text/comma-separated-values"};
        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        intent.addCategory(Intent.CATEGORY_OPENABLE);

        try {
            importFileLauncher.launch(intent);
        } catch (android.content.ActivityNotFoundException ex) {
            Toast.makeText(this, "Por favor, instale um aplicativo gerenciador de arquivos.", Toast.LENGTH_SHORT).show();
        }
    }

    public void importDBFile(View v) {
        new AlertDialog.Builder(this)
                .setTitle("Atenção")
                .setMessage("Se você importar um outro banco de dados o atual será perdido, tem certeza que deseja fazer isso?")
                .setIcon(android.R.drawable.ic_dialog_alert)
                .setPositiveButton(R.string.sim, new DialogInterface.OnClickListener() {

                    public void onClick(DialogInterface dialog, int whichButton) {
                        statusText = "";

                        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                        intent.setType("*/*");
                        intent.addCategory(Intent.CATEGORY_OPENABLE);

                        try {
                            importDBLauncher.launch(intent);
                        } catch (android.content.ActivityNotFoundException ex) {
                            Toast.makeText(ImportActivity.this, "Por favor, instale um aplicativo gerenciador de arquivos.", Toast.LENGTH_SHORT).show();
                        }
                    }})
                .setNegativeButton(android.R.string.cancel, null).show();
    }


    /**
     * Processa a importação de arquivo de texto/CSV usando URI
     */
    private void handleFileImport(Uri uri) {
        statusText = LOG_PREFIX;
        Toast.makeText(this, "Importando...", Toast.LENGTH_SHORT).show();

        try {
            InputStream inputStream = getContentResolver().openInputStream(uri);
            if (inputStream == null) {
                Toast.makeText(this, "Erro ao abrir arquivo", Toast.LENGTH_SHORT).show();
                return;
            }

            BufferedReader br = new BufferedReader(new InputStreamReader(inputStream));
            String line;
            int lineCounter = 0;

            while ((line = br.readLine()) != null) {
                lineCounter++;
                String[] separated = line.split(",");
                addImportedItem(separated);
            }
            br.close();

            if (lineCounter <= 0) {
                statusText = "Nenhum item encontrado :(";
            } else {
                statusText += "(" + lineCounter + ") itens encontrados :)\n\n";
            }

            if (status != null) {
                status.setText(statusText);
            } else {
                Log.e(TAG, "status field is null, cannot update status text");
            }

        } catch (IOException e) {
            Toast.makeText(this, "Erro ao importar arquivo: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            statusText += "Erro ao importar arquivo: " + e.getMessage();
            Log.e(TAG, "Erro ao importar arquivo", e);
        }
    }

    /**
     * Processa a importação de banco de dados usando URI
     */
    private void handleDBImport(Uri uri) {
        statusText = LOG_PREFIX;

        try {
            String currentDBPath = getDatabasePath("estoque").getAbsolutePath();
            File currentDB = new File(currentDBPath);

            InputStream inputStream = getContentResolver().openInputStream(uri);
            if (inputStream == null) {
                setImportExportDescText("Erro ao abrir arquivo de banco de dados");
                Toast.makeText(this, "Erro ao abrir arquivo de banco de dados", Toast.LENGTH_SHORT).show();
                return;
            }

            FileOutputStream outputStream = new FileOutputStream(currentDB);

            byte[] buffer = new byte[1024];
            int length;
            while ((length = inputStream.read(buffer)) > 0) {
                outputStream.write(buffer, 0, length);
            }

            outputStream.flush();
            outputStream.close();
            inputStream.close();

            MainActivity.instance.openOrCreateDB();
            MainActivity.instance.prepareList();
            MainActivity.instance.getListValues();
            MainActivity.instance.updateList();

            setImportExportDescText("Banco de dados importado com sucesso!\n\nOs produtos já estão disponíveis na lista.");
            Toast.makeText(this, "Banco de dados importado com sucesso!", Toast.LENGTH_SHORT).show();
            
            // Registrar interação para contagem de anúncios
            AdManager.getInstance(this).registerInteraction(this);

        } catch (Exception e) {
            setImportExportDescText("Erro ao importar: " + e.getMessage());
            Toast.makeText(this, "Ocorreu um erro ao importar o banco de dados.", Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao importar banco de dados", e);
        }
    }

    public void addImportedItem(String[] separated) {
        
        // Verificar se há pelo menos o campo nome
        if(separated == null || separated.length < 1) {
            statusText += "Linha inválida: formato incorreto\n\n";
            return;
        }

        String name = separated[0].trim();

        if(!MainActivity.instance.productAlreadyExists(name) && name != null && !name.equals("null") && !name.isEmpty()) {

            // Extrair todos os campos (com valores padrão para campos ausentes)
            String description = separated.length > 1 ? separated[1].trim() : "";
            String amount = separated.length > 2 ? separated[2].trim() : "0";
            String value = separated.length > 3 ? separated[3].trim() : "0";
            String photo = separated.length > 4 ? separated[4].trim() : "";
            String category = separated.length > 5 ? separated[5].trim() : "";
            String sku = separated.length > 6 ? separated[6].trim() : "";
            String barcode = separated.length > 7 ? separated[7].trim() : "";
            String supplier = separated.length > 8 ? separated[8].trim() : "";
            String location = separated.length > 9 ? separated[9].trim() : "";
            String minStock = separated.length > 10 ? separated[10].trim() : "";
            String unit = separated.length > 11 ? separated[11].trim() : "";

            // Validar e limpar valores nulos
            if(description == null || description.equals("null") || description.isEmpty()) {
                description = "";
            }

            if(amount == null || amount.equals("null") || amount.isEmpty()) {
                amount = "0";
            }

            if(value == null || value.equals("null") || value.isEmpty()) {
                value = "0";
            }

            if(photo == null || photo.equals("null")) {
                photo = "";
            }

            if(category == null || category.equals("null")) {
                category = "";
            }

            if(sku == null || sku.equals("null")) {
                sku = "";
            }

            if(barcode == null || barcode.equals("null")) {
                barcode = "";
            }

            if(supplier == null || supplier.equals("null")) {
                supplier = "";
            }

            if(location == null || location.equals("null")) {
                location = "";
            }

            if(minStock == null || minStock.equals("null")) {
                minStock = "";
            }

            if(unit == null || unit.equals("null")) {
                unit = "";
            }

            addProduct(name, description, amount, value, photo, category, sku, barcode, supplier, location, minStock, unit);
            statusText += "✓ " + name + " importado com sucesso\n\n";

        }  else {

            statusText += "✗ " + name + " não foi adicionado porque já existe um produto com esse nome.\n\n";

        }

    }

    public void addProduct(String name, String description, String amount, String value, 
                          String photo, String category, String sku, String barcode, 
                          String supplier, String location, String minStock, String unit) {

        ContentValues insertValues = new ContentValues();
        insertValues.put("name", name);
        insertValues.put("description", description);
        insertValues.put("amount", amount);
        insertValues.put("value", value);
        insertValues.put("photo", photo);
        insertValues.put("category", category);
        insertValues.put("sku", sku);
        insertValues.put("barcode", barcode);
        insertValues.put("supplier", supplier);
        insertValues.put("location", location);
        insertValues.put("min_stock", minStock);
        insertValues.put("unit", unit);

        // Verificar se o banco de dados está disponível antes de inserir
        if (!ensureDatabaseAvailable()) {
            Log.e(TAG, "Database is not available for insert operation");
            throw new IllegalStateException("Database not available");
        }

        try {
            MainActivity.stock.insert("Estoque", null, insertValues);

            if (MainActivity.instance != null) {
                MainActivity.instance.updateList();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error inserting product into database", e);
            throw new IllegalStateException("Error inserting into database: " + e.getMessage());
        }

    }

    public void exportDBFile(View view) {
        Date curDate = new Date();
        SimpleDateFormat simpleDate = new SimpleDateFormat("dd-M-yyyy_hh-mm-ss", Locale.getDefault());
        String strDt = simpleDate.format(curDate);

        // Criar intent para salvar arquivo usando Storage Access Framework
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/x-sqlite3");
        intent.putExtra(Intent.EXTRA_TITLE, "EstoqueSimples_" + strDt + ".db");

        try {
            exportDBLauncher.launch(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Erro ao iniciar exportação: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao iniciar exportação", e);
        }
    }

    /**
     * Processa a exportação de banco de dados usando URI
     */
    private void handleDBExport(Uri uri) {
        try {
            String currentDBPath = getDatabasePath("estoque").getAbsolutePath();
            File currentDB = new File(currentDBPath);

            if (!currentDB.exists()) {
                setImportExportDescText("Erro: Banco de dados não encontrado");
                Toast.makeText(this, "Banco de dados não encontrado", Toast.LENGTH_SHORT).show();
                return;
            }

            FileInputStream inputStream = new FileInputStream(currentDB);
            OutputStream outputStream = getContentResolver().openOutputStream(uri);

            if (outputStream == null) {
                setImportExportDescText("Erro ao criar arquivo de exportação");
                Toast.makeText(this, "Erro ao criar arquivo de exportação", Toast.LENGTH_SHORT).show();
                return;
            }

            byte[] buffer = new byte[1024];
            int length;
            while ((length = inputStream.read(buffer)) > 0) {
                outputStream.write(buffer, 0, length);
            }

            outputStream.flush();
            outputStream.close();
            inputStream.close();

            setImportExportDescText("Banco de dados exportado com sucesso!\n\nO arquivo foi salvo no local escolhido.");
            Toast.makeText(this, "Banco de dados exportado com sucesso!", Toast.LENGTH_SHORT).show();

        } catch (IOException e) {
            setImportExportDescText("Erro ao exportar: " + e.getMessage());
            Toast.makeText(this, "Ocorreu um erro ao exportar o banco de dados.", Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao exportar banco de dados", e);
        }
    }

    /**
     * Método público para exportar dados em formato CSV
     */
    public void exportCSVFile(View view) {
        Date curDate = new Date();
        SimpleDateFormat simpleDate = new SimpleDateFormat("dd-M-yyyy_hh-mm-ss", Locale.getDefault());
        String strDt = simpleDate.format(curDate);

        // Criar intent para salvar arquivo CSV
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/csv");
        intent.putExtra(Intent.EXTRA_TITLE, "EstoqueSimples_" + strDt + ".csv");

        try {
            exportCSVLauncher.launch(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Erro ao iniciar exportação: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao iniciar exportação CSV", e);
        }
    }

    /**
     * Processa a exportação dos dados em formato CSV
     */
    private void handleCSVExport(Uri uri) {
        try {
            OutputStream outputStream = getContentResolver().openOutputStream(uri);
            if (outputStream == null) {
                setImportExportDescText("Erro ao criar arquivo de exportação CSV");
                Toast.makeText(this, "Erro ao criar arquivo de exportação CSV", Toast.LENGTH_SHORT).show();
                return;
            }

            // Verificar se o banco de dados está disponível
            if (!ensureDatabaseAvailable()) {
                setImportExportDescText("Erro: Banco de dados não disponível");
                Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_LONG).show();
                Log.e(TAG, "Database not available for CSV export");
                outputStream.close();
                return;
            }

            // Buscar todos os produtos do banco de dados
            Cursor cursor = null;
            try {
                cursor = MainActivity.stock.rawQuery(
                    "SELECT name, description, amount, value, photo, category, sku, barcode, supplier, location, min_stock, unit FROM Estoque", 
                    null
                );
            } catch (Exception e) {
                Log.e(TAG, "Error querying database for CSV export", e);
                Toast.makeText(this, "Erro ao buscar dados: " + e.getMessage(), Toast.LENGTH_LONG).show();
                outputStream.close();
                return;
            }

            if (cursor == null) {
                setImportExportDescText("Erro ao buscar dados do banco");
                Toast.makeText(this, "Erro ao buscar dados do banco", Toast.LENGTH_SHORT).show();
                outputStream.close();
                return;
            }

            int exportedCount = 0;
            StringBuilder csvContent = new StringBuilder();

            // Processar cada produto
            if (cursor.moveToFirst()) {
                do {
                    String name = cursor.getString(0) != null ? cursor.getString(0) : "";
                    String description = cursor.getString(1) != null ? cursor.getString(1) : "";
                    String amount = cursor.getString(2) != null ? cursor.getString(2) : "0";
                    String value = cursor.getString(3) != null ? cursor.getString(3) : "0";
                    String photo = cursor.getString(4) != null ? cursor.getString(4) : "";
                    String category = cursor.getString(5) != null ? cursor.getString(5) : "";
                    String sku = cursor.getString(6) != null ? cursor.getString(6) : "";
                    String barcode = cursor.getString(7) != null ? cursor.getString(7) : "";
                    String supplier = cursor.getString(8) != null ? cursor.getString(8) : "";
                    String location = cursor.getString(9) != null ? cursor.getString(9) : "";
                    String minStock = cursor.getString(10) != null ? cursor.getString(10) : "";
                    String unit = cursor.getString(11) != null ? cursor.getString(11) : "";

                    // Escapar vírgulas e aspas nos valores (substituir vírgulas por ponto-e-vírgula se necessário)
                    name = escapeCSVValue(name);
                    description = escapeCSVValue(description);
                    photo = escapeCSVValue(photo);
                    category = escapeCSVValue(category);
                    sku = escapeCSVValue(sku);
                    barcode = escapeCSVValue(barcode);
                    supplier = escapeCSVValue(supplier);
                    location = escapeCSVValue(location);
                    unit = escapeCSVValue(unit);

                    // Montar a linha CSV com todos os 12 campos
                    csvContent.append(name).append(",")
                             .append(description).append(",")
                             .append(amount).append(",")
                             .append(value).append(",")
                             .append(photo).append(",")
                             .append(category).append(",")
                             .append(sku).append(",")
                             .append(barcode).append(",")
                             .append(supplier).append(",")
                             .append(location).append(",")
                             .append(minStock).append(",")
                             .append(unit).append("\n");

                    exportedCount++;
                } while (cursor.moveToNext());
            }
            
            // Fechar cursor
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Exception e) {
                    Log.e(TAG, "Error closing cursor", e);
                }
            }

            // Escrever conteúdo no arquivo
            outputStream.write(csvContent.toString().getBytes());
            outputStream.flush();
            outputStream.close();

            setImportExportDescText("Dados exportados com sucesso!\n\n" + 
                                   exportedCount + " produto(s) exportado(s) para CSV.\n\n" +
                                   "O arquivo foi salvo no local escolhido.");
            Toast.makeText(this, exportedCount + " produto(s) exportado(s) com sucesso!", Toast.LENGTH_LONG).show();

        } catch (Exception e) {
            setImportExportDescText("Erro ao exportar: " + e.getMessage());
            Toast.makeText(this, "Ocorreu um erro ao exportar os dados.", Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao exportar para CSV", e);
        }
    }

    /**
     * Escapa valores CSV removendo vírgulas problemáticas
     */
    private String escapeCSVValue(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        // Remover quebras de linha que podem quebrar o formato CSV
        value = value.replace("\n", " ").replace("\r", " ");
        // Substituir vírgulas por espaço (ou pode usar ponto-e-vírgula)
        value = value.replace(",", " ");
        return value;
    }

    public void showImportMessage() {

        AlertDialog alertDialog = new AlertDialog.Builder(ImportActivity.this).create();
        alertDialog.setTitle("Atenção");
        alertDialog.setMessage("Para importar arquivos é necessário que você possua um aplicativo de gerenciamento de arquivos.");
        alertDialog.setButton(AlertDialog.BUTTON_NEUTRAL, "Ok",
                new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int which) {
                        dialog.dismiss();
                    }
                });
        alertDialog.show();

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
                Log.d(TAG, "Attempting to initialize database through MainActivity");
                MainActivity.instance.openOrCreateDB();
                
                // Verificar se a inicialização foi bem-sucedida
                if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                    Log.d(TAG, "Database initialized successfully");
                    return true;
                }
            }

            // Última tentativa: tentar abrir o banco de dados diretamente
            Log.d(TAG, "Attempting to open database directly");
            MainActivity.stock = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
            
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                // Criar tabela se necessário
                MainActivity.stock.execSQL("CREATE TABLE IF NOT EXISTS Estoque(id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR, description VARCHAR, amount VARCHAR, value VARCHAR, photo VARCHAR, category VARCHAR, sku VARCHAR, barcode VARCHAR, supplier VARCHAR, location VARCHAR, min_stock VARCHAR, unit VARCHAR);");
                Log.d(TAG, "Database opened successfully");
                return true;
            }

            Log.e(TAG, "All attempts to open database failed");
            return false;

        } catch (Exception e) {
            Log.e(TAG, "Error ensuring database availability", e);
            return false;
        }
    }


}
