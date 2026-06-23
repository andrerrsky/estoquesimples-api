package br.com.gameloop.estoquesimples;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.ImageView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import com.squareup.picasso.Picasso;

import androidx.activity.result.PickVisualMediaRequest;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class EditActivity extends AppCompatActivity {

    private ImageView photo;
    private TextView name;
    private TextView amount;
    private TextView value;
    private Spinner currencySpinner;
    private com.google.android.material.textfield.TextInputLayout valueLayout;
    private TextView description;
    private TextView category;
    private TextView sku;
    private TextView barcode;
    private TextView supplier;
    private TextView location;
    private TextView minStock;
    private TextView unit;

    private String errorFeedback;

    public String productName;

    private File imagesFolder;
    private String lastPhotoName;
    private String newPhotoPath;

    // Constantes
    private static final String TAG = "EditActivity";
    private static final String IMAGE_TYPE = "image/*";
    private static final String ERROR_DISPLAY_PHOTO = "Erro ao exibir foto";
    
    // Keys para salvar estado
    private static final String STATE_PHOTO_PATH = "photoPath";
    private static final String STATE_LAST_PHOTO_NAME = "lastPhotoName";

    // ActivityResultLaunchers para capturar resultados
    private ActivityResultLauncher<Intent> cameraLauncher;
    private ActivityResultLauncher<PickVisualMediaRequest> galleryLauncher;
    private ActivityResultLauncher<String[]> permissionLauncher;
    private ActivityResultLauncher<ScanOptions> barcodeLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_edit);

        productName = null;
        newPhotoPath = null;

        if (getIntent().hasExtra("productName")) {
            productName = getIntent().getStringExtra("productName");
        } else {
            Toast.makeText(EditActivity.this, "Erro ao editar produto.", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        // Verificar se o banco de dados está disponível
        if (!ensureDatabaseInitialized()) {
            Toast.makeText(EditActivity.this, "Erro: Banco de dados não disponível. Reiniciando aplicação...", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Database not available in EditActivity");
            // Voltar para MainActivity para inicializar o banco de dados
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            finish();
            return;
        }

        // Inicializar campos com verificação de erro
        photo = (ImageView) findViewById(R.id.editPhoto);
        name = (TextView) findViewById(R.id.editName);
        amount = (TextView) findViewById(R.id.editAmount);
        value = (TextView) findViewById(R.id.editValue);
        description = (TextView) findViewById(R.id.editDescription);
        category = (TextView) findViewById(R.id.editCategory);
        sku = (TextView) findViewById(R.id.editSku);
        barcode = (TextView) findViewById(R.id.editBarcode);
        supplier = (TextView) findViewById(R.id.editSupplier);
        location = (TextView) findViewById(R.id.editLocation);
        minStock = (TextView) findViewById(R.id.editMinStock);
        unit = (TextView) findViewById(R.id.editUnit);
        currencySpinner = (Spinner) findViewById(R.id.editCurrencySpinner);
        valueLayout = findViewById(R.id.editValueLayout);

        setupCurrencySpinner();

        // Verificar se os campos obrigatórios foram inicializados
        if (name == null) {
            Log.e(TAG, "Failed to initialize name from layout");
        }
        if (amount == null) {
            Log.e(TAG, "Failed to initialize amount from layout");
        }
        if (value == null) {
            Log.e(TAG, "Failed to initialize value from layout");
        }
        if (photo == null) {
            Log.e(TAG, "Failed to initialize photo from layout");
        }

        // Verificar se algum campo obrigatório falhou
        if (!areFieldsInitialized()) {
            Toast.makeText(this, "Erro ao carregar interface. Por favor, reinicie o aplicativo.", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Critical fields not initialized, closing activity");
            finish();
            return;
        }

        errorFeedback = "Erros encontrados:\n";

        name.setText(productName);

        // Carregar dados do produto com tratamento de erro
        if (!getItemValuesByName(productName)) {
            Toast.makeText(EditActivity.this, "Erro ao carregar dados do produto.", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        this.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);

        // Inicializar launchers para Activity Results
        initializeActivityResultLaunchers();

        // Criar diretório de imagens no armazenamento interno da app
        initializeImageFolder();

        // Restaurar estado salvo se existir
        if (savedInstanceState != null) {
            String savedPhotoPath = savedInstanceState.getString(STATE_PHOTO_PATH);
            String savedPhotoName = savedInstanceState.getString(STATE_LAST_PHOTO_NAME);
            
            if (savedPhotoPath != null) {
                newPhotoPath = savedPhotoPath;
            }
            if (savedPhotoName != null) {
                lastPhotoName = savedPhotoName;
            }
            
            // Se havia uma foto nova não salva, exibi-la
            if (newPhotoPath != null && !newPhotoPath.isEmpty()) {
                try {
                    File photoFile = new File(newPhotoPath);
                    if (photoFile.exists()) {
                        displayPhoto(newPhotoPath);
                    } else if (newPhotoPath.startsWith("content://")) {
                        displayPhotoFromUri(Uri.parse(newPhotoPath));
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error restoring photo from saved state", e);
                }
            }
        }

        // Configurar e mostrar MREC do Appodeal com AdManager
        initializeAppodealAds();

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
    
    /**
     * Inicializa o diretório de imagens com validações robustas
     */
    private void initializeImageFolder() {
        Log.d(TAG, "initializeImageFolder called");
        
        try {
            // Tentar usar diretório externo primeiro (preferível)
            File externalFilesDir = null;
            try {
                externalFilesDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            } catch (Exception e) {
                Log.e(TAG, "Error getting external files directory", e);
            }
            
            if (externalFilesDir != null) {
                Log.d(TAG, "External files dir available: " + externalFilesDir.getAbsolutePath());
                
                try {
                    imagesFolder = new File(externalFilesDir, "EstoqueSimples");
                } catch (NullPointerException e) {
                    Log.e(TAG, "CRITICAL: NullPointerException creating imagesFolder with external dir", e);
                    imagesFolder = null;
                }
                
                if (imagesFolder != null) {
                    if (!imagesFolder.exists()) {
                        Log.d(TAG, "Images folder does not exist, creating: " + imagesFolder.getAbsolutePath());
                        boolean created = false;
                        try {
                            created = imagesFolder.mkdirs();
                        } catch (SecurityException e) {
                            Log.e(TAG, "SecurityException creating images folder", e);
                        }
                        
                        if (!created) {
                            Log.e(TAG, "Failed to create images folder at external dir");
                            imagesFolder = null; // Force fallback
                        } else {
                            Log.d(TAG, "Images folder created successfully");
                        }
                    } else {
                        Log.d(TAG, "Images folder already exists");
                    }
                }
            } else {
                Log.w(TAG, "getExternalFilesDir returned null, will use internal storage");
            }
            
            // Fallback para diretório interno se externo falhou
            if (imagesFolder == null) {
                Log.w(TAG, "Using fallback: internal files directory");
                
                File internalFilesDir = null;
                try {
                    internalFilesDir = getFilesDir();
                } catch (Exception e) {
                    Log.e(TAG, "CRITICAL: Error getting internal files directory", e);
                }
                
                if (internalFilesDir != null) {
                    try {
                        imagesFolder = new File(internalFilesDir, "EstoqueSimples");
                    } catch (NullPointerException e) {
                        Log.e(TAG, "CRITICAL: NullPointerException creating imagesFolder with internal dir", e);
                        imagesFolder = null;
                    }
                    
                    if (imagesFolder != null) {
                        if (!imagesFolder.exists()) {
                            Log.d(TAG, "Creating images folder in internal storage: " + imagesFolder.getAbsolutePath());
                            try {
                                boolean created = imagesFolder.mkdirs();
                                if (!created) {
                                    Log.e(TAG, "CRITICAL: Failed to create images folder in internal storage");
                                    imagesFolder = null;
                                } else {
                                    Log.d(TAG, "Images folder created in internal storage successfully");
                                }
                            } catch (SecurityException e) {
                                Log.e(TAG, "CRITICAL: SecurityException creating images folder in internal storage", e);
                                imagesFolder = null;
                            }
                        }
                    }
                } else {
                    Log.e(TAG, "CRITICAL: Both external and internal files directories are null");
                }
            }
            
            // Log final do resultado
            if (imagesFolder != null) {
                Log.d(TAG, "Images folder initialized successfully at: " + imagesFolder.getAbsolutePath());
                Log.d(TAG, "Images folder - exists: " + imagesFolder.exists() + ", canWrite: " + imagesFolder.canWrite());
            } else {
                Log.e(TAG, "CRITICAL: Failed to initialize images folder after all attempts");
                Toast.makeText(this, "Erro crítico: Não foi possível inicializar pasta de imagens", Toast.LENGTH_LONG).show();
            }
            
        } catch (Exception e) {
            Log.e(TAG, "Unexpected exception in initializeImageFolder: " + e.getClass().getName(), e);
            Toast.makeText(this, "Erro crítico ao inicializar pasta de imagens: " + e.getMessage(), Toast.LENGTH_LONG).show();
            imagesFolder = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        // Salvar o estado da foto
        if (newPhotoPath != null) {
            outState.putString(STATE_PHOTO_PATH, newPhotoPath);
        }
        if (lastPhotoName != null) {
            outState.putString(STATE_LAST_PHOTO_NAME, lastPhotoName);
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

    /**
     * Inicializa os launchers para capturar resultados de câmera, galeria e permissões
     */
    private void initializeActivityResultLaunchers() {
        // Launcher para câmera com tratamento robusto de erros
        cameraLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                try {
                    Log.d(TAG, "Camera result received - resultCode: " + result.getResultCode());
                    
                    if (result.getResultCode() == RESULT_OK) {
                        handleCameraResult();
                    } else if (result.getResultCode() == RESULT_CANCELED) {
                        Log.d(TAG, "Camera operation canceled by user");
                        Toast.makeText(this, "Captura de foto cancelada", Toast.LENGTH_SHORT).show();
                        // Limpar estado da foto não capturada
                        lastPhotoName = null;
                    } else {
                        Log.w(TAG, "Camera returned unexpected result code: " + result.getResultCode());
                        Toast.makeText(this, "Erro ao capturar foto", Toast.LENGTH_SHORT).show();
                        // Limpar estado inconsistente
                        lastPhotoName = null;
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Exception in camera launcher callback", e);
                    Toast.makeText(this, "Erro ao processar resultado da câmera: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    lastPhotoName = null;
                }
            }
        );

        // Launcher para galeria (Android Photo Picker - não requer permissão)
        galleryLauncher = registerForActivityResult(
            new ActivityResultContracts.PickVisualMedia(),
            uri -> {
                if (uri != null) {
                    handleGalleryResult(uri);
                }
            }
        );

        // Launcher para permissões múltiplas
        permissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(),
            permissions -> {
                boolean allGranted = true;
                for (Boolean granted : permissions.values()) {
                    if (!granted) {
                        allGranted = false;
                        break;
                    }
                }
                
                if (!allGranted) {
                    Toast.makeText(this, "Permissões são necessárias para usar câmera e galeria", Toast.LENGTH_LONG).show();
                }
            }
        );

        // Launcher para scanner de código de barras
        barcodeLauncher = registerForActivityResult(
            new ScanContract(),
            result -> {
                if (result.getContents() != null) {
                    if (barcode != null) {
                        barcode.setText(result.getContents());
                        Toast.makeText(this, "Código de barras: " + result.getContents(), Toast.LENGTH_SHORT).show();
                    } else {
                        Log.e(TAG, "barcode field is null when trying to set barcode value");
                        Toast.makeText(this, "Erro: Campo de código de barras não disponível", Toast.LENGTH_SHORT).show();
                    }
                } else {
                    Toast.makeText(this, "Scan cancelado", Toast.LENGTH_SHORT).show();
                }
            }
        );
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.options_menu, menu);
        return true;
    }

    /**
     * Normaliza uma quantidade armazenada para exibição no campo de edição:
     * remove o ".0" de inteiros e não usa separador de milhar (o texto é
     * gravado bruto ao salvar). Retorna "0" para valores nulos/vazios.
     */
    private static String formatAmountForEdit(String stored) {
        if (stored == null || stored.trim().isEmpty() || stored.equalsIgnoreCase("null")) {
            return "0";
        }
        return CurrencyHelper.quantityForStorage(CurrencyHelper.parseCurrency(stored, 0));
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
        } else if (item.getItemId() == R.id.menu_settings) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    /**
     * Verifica se todos os campos obrigatórios foram inicializados
     * @return true se todos os campos obrigatórios não são null
     */
    private boolean areFieldsInitialized() {
        if (name == null) {
            Log.e(TAG, "name is null");
            return false;
        }
        if (amount == null) {
            Log.e(TAG, "amount is null");
            return false;
        }
        if (value == null) {
            Log.e(TAG, "value is null");
            return false;
        }
        return true;
    }

    private void setupCurrencySpinner() {
        if (currencySpinner == null) return;
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_item, CurrencyHelper.AVAILABLE_CURRENCIES);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        currencySpinner.setAdapter(adapter);

        String current = CurrencyHelper.getCurrencySymbol(this);
        for (int i = 0; i < CurrencyHelper.AVAILABLE_CURRENCIES.length; i++) {
            if (CurrencyHelper.AVAILABLE_CURRENCIES[i].equals(current)) {
                currencySpinner.setSelection(i);
                break;
            }
        }

        if (valueLayout != null) {
            valueLayout.setHint(getString(R.string.currency_label_value, current));
        }

        currencySpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                String selected = CurrencyHelper.AVAILABLE_CURRENCIES[position];
                CurrencyHelper.setCurrencySymbol(EditActivity.this, selected);
                if (valueLayout != null) {
                    valueLayout.setHint(getString(R.string.currency_label_value, selected));
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
    }

    /**
     * Garante que o banco de dados está inicializado
     * @return true se o banco de dados está disponível, false caso contrário
     */
    private boolean ensureDatabaseInitialized() {
        try {
            // Verificar se MainActivity.stock está inicializado
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }

            // Tentar inicializar se MainActivity.instance está disponível
            if (MainActivity.instance != null) {
                MainActivity.instance.openOrCreateDB();
                return MainActivity.stock != null && MainActivity.stock.isOpen();
            }

            // Se não conseguiu, tentar abrir diretamente
            Log.w(TAG, "MainActivity.stock is null, attempting to initialize database");
            SQLiteDatabase db = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
            if (db != null && db.isOpen()) {
                MainActivity.stock = db;
                // Criar tabelas se necessário
                db.execSQL("CREATE TABLE IF NOT EXISTS Estoque(id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR, description VARCHAR, amount VARCHAR, value VARCHAR, photo VARCHAR, category VARCHAR, sku VARCHAR, barcode VARCHAR, supplier VARCHAR, location VARCHAR, min_stock VARCHAR, unit VARCHAR);");
                return true;
            }
            
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error ensuring database initialized", e);
            return false;
        }
    }

    /**
     * Busca os valores do produto por nome usando query parametrizada (segura contra SQL injection)
     * @param productName Nome do produto
     * @return true se os dados foram carregados com sucesso, false caso contrário
     */
    private boolean getItemValuesByName(String productName) {
        if (productName == null || productName.trim().isEmpty()) {
            Log.e(TAG, "Product name is null or empty");
            return false;
        }

        Cursor cursor = null;
        try {
            // Usar query parametrizada para prevenir SQL injection
            cursor = MainActivity.stock.rawQuery(
                "SELECT description, amount, value, photo, category, sku, barcode, supplier, location, min_stock, unit FROM Estoque WHERE name=?", 
                new String[]{productName}
            );

            if (cursor != null && cursor.moveToFirst()) {
                String columnDescription = cursor.getString(0);
                String columnAmount = cursor.getString(1);
                String columnValue = cursor.getString(2);
                String columnPhoto = cursor.getString(3);
                String columnCategory = cursor.getString(4);
                String columnSku = cursor.getString(5);
                String columnBarcode = cursor.getString(6);
                String columnSupplier = cursor.getString(7);
                String columnLocation = cursor.getString(8);
                String columnMinStock = cursor.getString(9);
                String columnUnit = cursor.getString(10);

                // Usar valores padrão para campos nulos
                description.setText(columnDescription != null ? columnDescription : "");
                // Quantidade/estoque mínimo: normalizar para não exibir ".0" em inteiros
                // (sem separador de milhar, pois o texto é gravado bruto ao salvar)
                amount.setText(formatAmountForEdit(columnAmount));
                value.setText(columnValue != null ? columnValue : "0");
                category.setText(columnCategory != null ? columnCategory : "");
                sku.setText(columnSku != null ? columnSku : "");
                barcode.setText(columnBarcode != null ? columnBarcode : "");
                supplier.setText(columnSupplier != null ? columnSupplier : "");
                location.setText(columnLocation != null ? columnLocation : "");
                minStock.setText(formatAmountForEdit(columnMinStock));
                unit.setText(columnUnit != null ? columnUnit : "");

                // Carregar foto se disponível
                if (columnPhoto != null && !columnPhoto.isEmpty() && !columnPhoto.equals("null")) {
                    try {
                        if (photo == null) {
                            Log.e(TAG, "photo field is null, cannot display photo");
                        } else {
                            File photoFile = new File(columnPhoto);
                            if (photoFile.exists()) {
                                photo.setImageBitmap(BitmapFactory.decodeFile(columnPhoto));
                                final String finalColumnPhoto = columnPhoto;
                                photo.setOnClickListener(v -> {
                                    try {
                                        File file = new File(finalColumnPhoto);
                                        
                                        // Usar FileUriHelper para criar URI segura
                                        Uri photoUri = FileUriHelper.getUriForFile(EditActivity.this, file);
                                        
                                        if (photoUri == null) {
                                            Toast.makeText(EditActivity.this, "Erro ao criar referência para foto", Toast.LENGTH_SHORT).show();
                                            Log.e(TAG, "Failed to create URI for photo");
                                            return;
                                        }
                                        
                                        // Verificar se a URI é segura
                                        if (!FileUriHelper.isUriSafe(photoUri)) {
                                            Toast.makeText(EditActivity.this, "Erro de segurança ao abrir foto", Toast.LENGTH_SHORT).show();
                                            Log.e(TAG, "Created URI is not safe: " + photoUri);
                                            return;
                                        }
                                        
                                        Intent intent = new Intent(Intent.ACTION_VIEW);
                                        intent.setDataAndType(photoUri, IMAGE_TYPE);
                                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                        startActivity(intent);
                                    } catch (android.os.FileUriExposedException e) {
                                        Toast.makeText(EditActivity.this, "Erro de segurança ao abrir foto. Por favor, atualize o aplicativo.", Toast.LENGTH_SHORT).show();
                                        Log.e(TAG, "FileUriExposedException when opening photo", e);
                                    } catch (Exception e) {
                                        Toast.makeText(EditActivity.this, "Erro ao abrir foto", Toast.LENGTH_SHORT).show();
                                        Log.e(TAG, "Error opening photo", e);
                                    }
                                });
                            } else {
                                Log.w(TAG, "Photo file does not exist: " + columnPhoto);
                            }
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Error loading photo", e);
                    }
                }

                return true;
            } else {
                Log.e(TAG, "Product not found in database: " + productName);
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error loading product data", e);
            Toast.makeText(this, "Erro ao carregar dados do produto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            return false;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
    }

    public void cancelEdit(View v) {
        finish();
    }

    public void editProduct(View v) {

        // Verificar se os campos foram inicializados
        if (!areFieldsInitialized()) {
            Toast.makeText(EditActivity.this, "Erro: Campos não foram carregados corretamente. Por favor, tente novamente.", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Fields not initialized in editProduct");
            finish();
            return;
        }

        if (!isValid()) {
            Toast.makeText(EditActivity.this, errorFeedback, Toast.LENGTH_LONG).show();
            errorFeedback = "Erros encontrados:\n";
            return;
        }

        // Verificar se o banco de dados está disponível
        if (!ensureDatabaseInitialized()) {
            Toast.makeText(EditActivity.this, "Erro: Banco de dados não disponível.", Toast.LENGTH_SHORT).show();
            return;
        }

        try {
            ContentValues updateValues = new ContentValues();
            updateValues.put("name", name.getText().toString().trim());
            updateValues.put("amount", amount.getText().toString().replace(" ", "").trim());
            updateValues.put("value", CurrencyHelper.sanitizeForStorage(value.getText().toString()));
            updateValues.put("description", description != null ? description.getText().toString().trim() : "");
            
            // Novos campos com verificação null
            updateValues.put("category", category != null ? category.getText().toString().trim() : "");
            updateValues.put("sku", sku != null ? sku.getText().toString().trim() : "");
            updateValues.put("barcode", barcode != null ? barcode.getText().toString().trim() : "");
            updateValues.put("supplier", supplier != null ? supplier.getText().toString().trim() : "");
            updateValues.put("location", location != null ? location.getText().toString().trim() : "");
            updateValues.put("min_stock", minStock != null ? minStock.getText().toString().trim() : "");
            updateValues.put("unit", unit != null ? unit.getText().toString().trim() : "");

            if (newPhotoPath != null) {
                updateValues.put("photo", newPhotoPath);
            }

            // Usar query parametrizada para segurança (prevenir SQL injection)
            int rowsAffected = MainActivity.stock.update("Estoque", updateValues, "name=?", new String[]{productName});

            if (rowsAffected > 0) {
                // Atualizar lista se MainActivity está disponível
                if (MainActivity.instance != null) {
                    MainActivity.instance.updateList();
                }

                Toast.makeText(EditActivity.this, "Produto atualizado com sucesso.", Toast.LENGTH_SHORT).show();
                
                // Registrar interação para contagem de anúncios
                try {
                    AdManager.getInstance(this).registerInteraction(this);
                } catch (Exception e) {
                    Log.e(TAG, "Error registering ad interaction", e);
                }
                
                // Verificar e agendar notificações de estoque baixo
                try {
                    LowStockScheduler.checkAndScheduleNotifications(this);
                } catch (Exception e) {
                    Log.e(TAG, "Error checking low stock notifications", e);
                }

                finish();
            } else {
                Toast.makeText(EditActivity.this, "Erro: Produto não encontrado para atualização.", Toast.LENGTH_SHORT).show();
                Log.w(TAG, "No rows affected when updating product: " + productName);
            }

        } catch (Exception e) {
            Log.e(TAG, "Error updating product", e);
            Toast.makeText(EditActivity.this, "Erro ao atualizar produto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }

    }

    public boolean isValid() {

        // Verificação adicional de segurança
        if (!areFieldsInitialized()) {
            Log.e(TAG, "Cannot validate: fields not initialized");
            errorFeedback += "\n- Erro interno: campos não inicializados;";
            return false;
        }

        boolean isValid = true;

        try {
            String nameText = name.getText().toString();
            if (nameText == null || nameText.isEmpty() || nameText.equals("null")) {
                errorFeedback += "\n- Nome do produto é invalido;";
                isValid = false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product name", e);
            errorFeedback += "\n- Erro ao validar nome do produto;";
            isValid = false;
        }

        try {
            String amountText = amount.getText().toString();
            if (amountText == null || amountText.isEmpty() || amountText.equals("null")) {
                errorFeedback += "\n- Quantidade do produto é invalida;";
                isValid = false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product amount", e);
            errorFeedback += "\n- Erro ao validar quantidade do produto;";
            isValid = false;
        }

        try {
            String valueText = value.getText().toString();
            if (valueText == null || valueText.isEmpty() || valueText.equals("null")) {
                errorFeedback += "\n- Valor do produto é invalido;";
                isValid = false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product value", e);
            errorFeedback += "\n- Erro ao validar valor do produto;";
            isValid = false;
        }

        return isValid;

    }

    public void editTakeCameraPhoto(View v) {
        if (checkAndRequestPermissions(true)) {
            openCamera();
        }
    }

    public void editTakeGalleryPhoto(View v) {
        // O Android Photo Picker não exige permissão de acesso à mídia
        openGallery();
    }

    /**
     * Verifica e solicita permissões necessárias.
     * Apenas a câmera exige permissão em tempo de execução; a galeria usa o
     * Android Photo Picker, que concede acesso pontual sem permissão.
     * @param forCamera true se for para câmera
     * @return true se todas as permissões já foram concedidas
     */
    private boolean checkAndRequestPermissions(boolean forCamera) {
        List<String> permissionsNeeded = new ArrayList<>();

        if (forCamera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) 
                != PackageManager.PERMISSION_GRANTED) {
            permissionsNeeded.add(Manifest.permission.CAMERA);
        }

        if (!permissionsNeeded.isEmpty()) {
            permissionLauncher.launch(permissionsNeeded.toArray(new String[0]));
            return false;
        }

        return true;
    }

    /**
     * Abre a câmera usando FileProvider com validações robustas
     */
    private void openCamera() {
        Log.d(TAG, "openCamera called");
        
        try {
            // Validação crítica 1: verificar e inicializar pasta de imagens
            if (imagesFolder == null) {
                Log.w(TAG, "imagesFolder is null in openCamera, reinitializing");
                initializeImageFolder();
                
                if (imagesFolder == null) {
                    Log.e(TAG, "CRITICAL: Failed to initialize imagesFolder in openCamera");
                    Toast.makeText(this, "Erro crítico: Não foi possível criar pasta de imagens", Toast.LENGTH_LONG).show();
                    return;
                }
                Log.d(TAG, "imagesFolder reinitialized: " + imagesFolder.getAbsolutePath());
            }
            
            // Validação crítica 2: verificar se imagesFolder é válido
            if (!imagesFolder.exists()) {
                Log.w(TAG, "imagesFolder does not exist, creating: " + imagesFolder.getAbsolutePath());
                boolean created = imagesFolder.mkdirs();
                if (!created) {
                    Log.e(TAG, "CRITICAL: Failed to create imagesFolder in openCamera");
                    Toast.makeText(this, "Erro crítico: Não foi possível criar pasta de imagens", Toast.LENGTH_LONG).show();
                    return;
                }
            }

            Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            
            // Verificar se há um app de câmera disponível
            if (cameraIntent.resolveActivity(getPackageManager()) == null) {
                Log.e(TAG, "No camera app available on device");
                Toast.makeText(this, "Nenhum aplicativo de câmera disponível", Toast.LENGTH_LONG).show();
                return;
            }

            // Gerar nome único para a foto com validação
            String timeStamp = null;
            try {
                timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
            } catch (Exception e) {
                Log.e(TAG, "Error formatting timestamp, using fallback", e);
                timeStamp = String.valueOf(System.currentTimeMillis());
            }
            
            lastPhotoName = "es_" + timeStamp + ".jpg";
            Log.d(TAG, "Generated photo name: " + lastPhotoName);
            
            // Validação crítica 3: criar arquivo com verificação de nulos
            File imageFile = null;
            try {
                imageFile = new File(imagesFolder, lastPhotoName);
            } catch (NullPointerException e) {
                Log.e(TAG, "CRITICAL: NullPointerException creating imageFile - imagesFolder: " 
                        + imagesFolder + ", lastPhotoName: " + lastPhotoName, e);
                Toast.makeText(this, "Erro crítico ao preparar arquivo de foto", Toast.LENGTH_LONG).show();
                // Limpar estado inconsistente
                lastPhotoName = null;
                return;
            }
            
            if (imageFile == null) {
                Log.e(TAG, "CRITICAL: imageFile is null after creation");
                Toast.makeText(this, "Erro crítico ao preparar arquivo de foto", Toast.LENGTH_LONG).show();
                lastPhotoName = null;
                return;
            }

            Log.d(TAG, "Creating photo file at: " + imageFile.getAbsolutePath());

            // Usar FileProvider para criar URI segura com validação
            Uri photoUri = null;
            try {
                photoUri = FileProvider.getUriForFile(
                    this,
                    getApplicationContext().getPackageName() + ".fileprovider",
                    imageFile
                );
            } catch (IllegalArgumentException e) {
                Log.e(TAG, "FileProvider error - check fileprovider configuration and file paths", e);
                Toast.makeText(this, "Erro de configuração ao preparar câmera", Toast.LENGTH_LONG).show();
                lastPhotoName = null;
                return;
            } catch (NullPointerException e) {
                Log.e(TAG, "CRITICAL: NullPointerException in FileProvider.getUriForFile", e);
                Toast.makeText(this, "Erro crítico ao preparar câmera", Toast.LENGTH_LONG).show();
                lastPhotoName = null;
                return;
            }
            
            if (photoUri == null) {
                Log.e(TAG, "CRITICAL: photoUri is null from FileProvider");
                Toast.makeText(this, "Erro ao preparar câmera", Toast.LENGTH_LONG).show();
                lastPhotoName = null;
                return;
            }
            
            Log.d(TAG, "Photo URI created: " + photoUri);

            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            try {
                cameraLauncher.launch(cameraIntent);
                Log.d(TAG, "Camera intent launched successfully with photo name: " + lastPhotoName);
            } catch (Exception e) {
                Log.e(TAG, "Error launching camera intent", e);
                Toast.makeText(this, "Erro ao abrir aplicativo de câmera", Toast.LENGTH_LONG).show();
                lastPhotoName = null;
            }

        } catch (SecurityException e) {
            Log.e(TAG, "SecurityException in openCamera - permission denied", e);
            Toast.makeText(this, "Erro de permissão. Verifique as permissões do app.", Toast.LENGTH_LONG).show();
            lastPhotoName = null;
        } catch (Exception e) {
            Log.e(TAG, "Unexpected exception in openCamera: " + e.getClass().getName(), e);
            Toast.makeText(this, "Erro inesperado ao abrir câmera: " + e.getMessage(), Toast.LENGTH_LONG).show();
            lastPhotoName = null;
        }
    }

    /**
     * Abre a galeria de fotos
     */
    private void openGallery() {
        galleryLauncher.launch(new PickVisualMediaRequest.Builder()
                .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE)
                .build());
    }

    /**
     * Processa o resultado da câmera com verificações de segurança robustas
     */
    private void handleCameraResult() {
        Log.d(TAG, "handleCameraResult called");
        
        try {
            // Validação crítica 1: verificar se imagesFolder está inicializado
            if (imagesFolder == null) {
                Log.e(TAG, "CRITICAL: imagesFolder is null in handleCameraResult, attempting to reinitialize");
                initializeImageFolder();
                
                // Verificação dupla após reinicialização
                if (imagesFolder == null) {
                    Log.e(TAG, "CRITICAL: imagesFolder still null after reinitialization");
                    Toast.makeText(this, "Erro crítico: Pasta de imagens não disponível", Toast.LENGTH_LONG).show();
                    return;
                }
                Log.d(TAG, "imagesFolder reinitialized successfully: " + imagesFolder.getAbsolutePath());
            }
            
            // Validação crítica 2: verificar se lastPhotoName está definido
            if (lastPhotoName == null || lastPhotoName.trim().isEmpty()) {
                Log.e(TAG, "CRITICAL: lastPhotoName is null or empty - lastPhotoName: " + lastPhotoName);
                Toast.makeText(this, "Erro crítico: Nome da foto não foi definido corretamente", Toast.LENGTH_LONG).show();
                return;
            }
            
            // Validação crítica 3: verificar se imagesFolder é um diretório válido
            if (!imagesFolder.exists()) {
                Log.w(TAG, "imagesFolder does not exist, attempting to create: " + imagesFolder.getAbsolutePath());
                boolean created = imagesFolder.mkdirs();
                if (!created) {
                    Log.e(TAG, "CRITICAL: Failed to create imagesFolder");
                    Toast.makeText(this, "Erro crítico: Não foi possível criar pasta de imagens", Toast.LENGTH_LONG).show();
                    return;
                }
            }
            
            if (!imagesFolder.isDirectory()) {
                Log.e(TAG, "CRITICAL: imagesFolder is not a directory: " + imagesFolder.getAbsolutePath());
                Toast.makeText(this, "Erro crítico: Caminho de imagens inválido", Toast.LENGTH_LONG).show();
                return;
            }

            // Log detalhado para debug
            Log.d(TAG, "Creating File with - imagesFolder: " + imagesFolder.getAbsolutePath() 
                    + ", lastPhotoName: " + lastPhotoName);

            // Criar o arquivo com validações - agora com verificações completas
            File imgFile = null;
            try {
                imgFile = new File(imagesFolder, lastPhotoName);
            } catch (NullPointerException e) {
                Log.e(TAG, "CRITICAL: NullPointerException when creating File - imagesFolder: " 
                        + imagesFolder + ", lastPhotoName: " + lastPhotoName, e);
                Toast.makeText(this, "Erro crítico ao criar referência para foto", Toast.LENGTH_LONG).show();
                return;
            }
            
            // Validação adicional do arquivo criado
            if (imgFile == null) {
                Log.e(TAG, "CRITICAL: imgFile is null after creation");
                Toast.makeText(this, "Erro crítico: Arquivo de foto não foi criado", Toast.LENGTH_LONG).show();
                return;
            }
            
            Log.d(TAG, "Checking for photo at: " + imgFile.getAbsolutePath() + ", exists: " + imgFile.exists());

            // Verificar se a foto foi salva
            if (imgFile.exists() && imgFile.length() > 0) {
                newPhotoPath = imgFile.getAbsolutePath();
                displayPhoto(newPhotoPath);
                Log.d(TAG, "Photo saved successfully at: " + newPhotoPath + ", size: " + imgFile.length() + " bytes");
                Toast.makeText(this, "Foto capturada com sucesso", Toast.LENGTH_SHORT).show();
            } else {
                Log.e(TAG, "Photo file does not exist or is empty at: " + imgFile.getAbsolutePath() 
                        + ", exists: " + imgFile.exists() 
                        + ", length: " + (imgFile.exists() ? imgFile.length() : "N/A"));
                Toast.makeText(this, "Erro: Foto não foi salva pela câmera. Tente novamente.", Toast.LENGTH_LONG).show();
            }
            
        } catch (SecurityException e) {
            Log.e(TAG, "SecurityException in handleCameraResult - permission denied", e);
            Toast.makeText(this, "Erro de permissão ao acessar foto. Verifique as permissões do app.", Toast.LENGTH_LONG).show();
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "IllegalArgumentException in handleCameraResult - invalid path", e);
            Toast.makeText(this, "Erro: Caminho de arquivo inválido", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Log.e(TAG, "Unexpected exception in handleCameraResult: " + e.getClass().getName(), e);
            Toast.makeText(this, "Erro inesperado ao processar foto: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Processa o resultado da galeria
     */
    private void handleGalleryResult(Uri selectedImage) {
        if (selectedImage == null) {
            Toast.makeText(this, "Erro ao carregar esta imagem", Toast.LENGTH_SHORT).show();
            return;
        }

        // O Photo Picker concede acesso temporário à URI; copiamos para a pasta
        // do app para que a imagem permaneça disponível nas próximas sessões.
        String copiedPath = copyImageToAppFolder(selectedImage);
        if (copiedPath != null) {
            newPhotoPath = copiedPath;
            displayPhoto(copiedPath);
        } else {
            Toast.makeText(this, "Erro ao carregar imagem", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Copia a imagem selecionada (via Photo Picker) para a pasta interna do app
     * e retorna o caminho do arquivo gerado, ou null em caso de falha.
     */
    private String copyImageToAppFolder(Uri sourceUri) {
        if (imagesFolder == null) {
            initializeImageFolder();
            if (imagesFolder == null) {
                Log.e(TAG, "imagesFolder is null in copyImageToAppFolder");
                return null;
            }
        }
        if (!imagesFolder.exists()) {
            imagesFolder.mkdirs();
        }

        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
        File destFile = new File(imagesFolder, "es_" + timeStamp + ".jpg");

        try (InputStream in = getContentResolver().openInputStream(sourceUri);
             OutputStream out = new FileOutputStream(destFile)) {
            if (in == null) {
                Log.e(TAG, "Could not open input stream for picked image");
                return null;
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
            return destFile.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "Erro ao copiar imagem selecionada", e);
            return null;
        }
    }

    /**
     * Exibe a foto no ImageView a partir de um caminho de arquivo
     */
    private void displayPhoto(String photoPath) {
        try {
            if (photo == null) {
                Log.e(TAG, "photo is null, cannot display photo");
                Toast.makeText(this, "Erro: Campo de foto não disponível", Toast.LENGTH_SHORT).show();
                return;
            }

            Picasso.get()
                .load("file://" + photoPath)
                .resize(1200, 1200) // Limita dimensões máximas
                .centerInside() // Mantém aspect ratio
                .onlyScaleDown() // Não aumenta imagens menores
                .placeholder(R.drawable.package_icon) // Placeholder durante carregamento
                .error(R.drawable.package_icon) // Imagem de erro caso falhe
                .into(photo);
            
            setupPhotoClickListener(photoPath);
        } catch (Exception e) {
            Toast.makeText(this, ERROR_DISPLAY_PHOTO, Toast.LENGTH_SHORT).show();
            Log.e(TAG, ERROR_DISPLAY_PHOTO, e);
        }
    }

    /**
     * Exibe a foto no ImageView a partir de uma URI
     */
    private void displayPhotoFromUri(Uri uri) {
        try {
            if (photo == null) {
                Log.e(TAG, "photo is null, cannot display photo from URI");
                Toast.makeText(this, "Erro: Campo de foto não disponível", Toast.LENGTH_SHORT).show();
                return;
            }

            Picasso.get()
                .load(uri)
                .resize(1200, 1200) // Limita dimensões máximas
                .centerInside() // Mantém aspect ratio
                .onlyScaleDown() // Não aumenta imagens menores
                .placeholder(R.drawable.package_icon) // Placeholder durante carregamento
                .error(R.drawable.package_icon) // Imagem de erro caso falhe
                .into(photo);
            
            setupPhotoClickListenerUri(uri);
        } catch (Exception e) {
            Toast.makeText(this, ERROR_DISPLAY_PHOTO, Toast.LENGTH_SHORT).show();
            Log.e(TAG, ERROR_DISPLAY_PHOTO, e);
        }
    }

    /**
     * Configura o listener para visualizar a foto em tela cheia
     */
    private void setupPhotoClickListener(String photoPath) {
        if (photo == null) {
            Log.e(TAG, "photo is null, cannot setup click listener");
            return;
        }

        photo.setOnClickListener(v -> {
            try {
                File file = new File(photoPath);
                
                // Usar FileUriHelper para criar URI segura
                Uri photoUri = FileUriHelper.getUriForFile(EditActivity.this, file);
                
                if (photoUri == null) {
                    Toast.makeText(EditActivity.this, "Erro ao criar referência para foto", Toast.LENGTH_SHORT).show();
                    Log.e(TAG, "Failed to create URI for photo viewer");
                    return;
                }
                
                // Verificar se a URI é segura
                if (!FileUriHelper.isUriSafe(photoUri)) {
                    Toast.makeText(EditActivity.this, "Erro de segurança ao abrir foto", Toast.LENGTH_SHORT).show();
                    Log.e(TAG, "Created URI is not safe for photo viewer: " + photoUri);
                    return;
                }
                
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(photoUri, IMAGE_TYPE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(intent);
            } catch (android.os.FileUriExposedException e) {
                Log.e(TAG, "FileUriExposedException when opening photo viewer", e);
                Toast.makeText(EditActivity.this, "Erro de segurança ao abrir foto. Por favor, atualize o aplicativo.", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Log.e(TAG, "Error opening photo viewer", e);
                Toast.makeText(EditActivity.this, "Erro ao abrir visualizador de foto", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * Configura o listener para visualizar a foto em tela cheia (versão URI)
     */
    private void setupPhotoClickListenerUri(Uri uri) {
        if (photo == null) {
            Log.e(TAG, "photo is null, cannot setup click listener for URI");
            return;
        }

        photo.setOnClickListener(v -> {
            try {
                // Verificar se a URI é segura
                if (!FileUriHelper.isUriSafe(uri)) {
                    Toast.makeText(EditActivity.this, "Erro de segurança ao abrir foto", Toast.LENGTH_SHORT).show();
                    Log.e(TAG, "URI is not safe for sharing: " + uri);
                    return;
                }
                
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, IMAGE_TYPE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(intent);
            } catch (android.os.FileUriExposedException e) {
                Log.e(TAG, "FileUriExposedException when opening photo viewer from URI", e);
                Toast.makeText(EditActivity.this, "Erro de segurança ao abrir foto. Por favor, atualize o aplicativo.", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Log.e(TAG, "Error opening photo viewer from URI", e);
                Toast.makeText(EditActivity.this, "Erro ao abrir visualizador de foto", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * Inicia o scanner de código de barras
     */
    public void scanBarcode(View v) {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.ALL_CODE_TYPES);
        options.setPrompt("Escaneie o código de barras");
        options.setCameraId(0);
        options.setBeepEnabled(true);
        options.setBarcodeImageEnabled(false);
        options.setOrientationLocked(false);
        
        barcodeLauncher.launch(options);
    }

}
