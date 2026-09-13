package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.ProductRepository;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import android.os.Bundle;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Toast;

import com.google.android.material.textfield.TextInputLayout;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import androidx.activity.result.PickVisualMediaRequest;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class AddActivity extends BaseActivity {

    private EditText productName;
    private EditText productAmount;
    private EditText productValue;
    private Spinner currencySpinner;
    private TextInputLayout nameLayout;
    private TextInputLayout amountLayout;
    private TextInputLayout valueLayout;
    private ScrollView scrollView;
    private EditText productDescription;
    private EditText productCategory;
    private EditText productSku;
    private EditText productBarcode;
    private EditText productSupplier;
    private EditText productLocation;
    private EditText productMinStock;
    private EditText productUnit;
    private DiscardGuard discardGuard;
    private ImageView productPhoto;

    private File imagesFolder;
    private String lastPhotoName;
    private String newPhotoPath;

    // Constantes
    private static final String TAG = "AddActivity";
    private static final String IMAGE_TYPE = "image/*";
    private static final String ERROR_DISPLAY_PHOTO = "Erro ao exibir foto";
    
    // Keys para salvar estado
    private static final String STATE_PHOTO_PATH = "photoPath";
    private static final String STATE_LAST_PHOTO_NAME = "lastPhotoName";

    // ActivityResultLaunchers para capturar resultados
    private ActivityResultLauncher<Intent> cameraLauncher;
    private ActivityResultLauncher<PickVisualMediaRequest> galleryLauncher;
    private ActivityResultLauncher<String> cameraPermissionLauncher;
    private ActivityResultLauncher<ScanOptions> barcodeLauncher;
    private boolean pendingCameraLaunch;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_add);

        // Verificar se o banco de dados está disponível
        if (!ensureDatabaseInitialized()) {
            Toast.makeText(AddActivity.this, "Erro: Banco de dados não disponível. Reiniciando aplicação...", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Database not available in AddActivity");
            // Voltar para MainActivity para inicializar o banco de dados
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            finish();
            return;
        }

        // Inicializar campos com verificação de erro
        productName = (EditText) findViewById(R.id.addName);
        productAmount = (EditText) findViewById(R.id.addAmount);
        productValue = (EditText) findViewById(R.id.addValue);
        productDescription = (EditText) findViewById(R.id.addDescription);
        productCategory = (EditText) findViewById(R.id.addCategory);
        productSku = (EditText) findViewById(R.id.addSku);
        productBarcode = (EditText) findViewById(R.id.addBarcode);
        productSupplier = (EditText) findViewById(R.id.addSupplier);
        productLocation = (EditText) findViewById(R.id.addLocation);
        productMinStock = (EditText) findViewById(R.id.addMinStock);
        productUnit = (EditText) findViewById(R.id.addUnit);
        discardGuard = new DiscardGuard(this, "Descartar cadastro?");
        discardGuard.watch(productName, productAmount, productValue, productDescription, productCategory,
                productSku, productBarcode, productSupplier, productLocation, productMinStock, productUnit);
        FieldSuggestions.attach(MainActivity.stock,
                (android.widget.AutoCompleteTextView) findViewById(R.id.addCategory),
                (android.widget.AutoCompleteTextView) findViewById(R.id.addUnit),
                (android.widget.AutoCompleteTextView) findViewById(R.id.addSupplier));
        productPhoto = (ImageView) findViewById(R.id.addPhoto);
        currencySpinner = (Spinner) findViewById(R.id.addCurrencySpinner);
        nameLayout = findViewById(R.id.addNameLayout);
        amountLayout = findViewById(R.id.addAmountLayout);
        valueLayout = findViewById(R.id.addValueLayout);
        scrollView = findViewById(R.id.addScrollView);

        setupCurrencySpinner();

        // Verificar se os campos obrigatórios foram inicializados
        if (productName == null) {
            Log.e(TAG, "Failed to initialize productName from layout");
        }
        if (productAmount == null) {
            Log.e(TAG, "Failed to initialize productAmount from layout");
        }
        if (productValue == null) {
            Log.e(TAG, "Failed to initialize productValue from layout");
        }
        if (productPhoto == null) {
            Log.e(TAG, "Failed to initialize productPhoto from layout");
        }

        // Verificar se algum campo obrigatório falhou
        if (!areFieldsInitialized()) {
            Toast.makeText(this, "Erro ao carregar interface. Por favor, reinicie o aplicativo.", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Critical fields not initialized, closing activity");
            finish();
            return;
        }

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        getSupportActionBar().setTitle("Novo produto");

        this.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);

        // Inicializar launchers para Activity Results
        initializeActivityResultLaunchers();

        // Criar diretório de imagens no armazenamento interno da app
        initializeImageFolder();

        // Restaurar estado salvo se existir
        if (savedInstanceState != null) {
            newPhotoPath = savedInstanceState.getString(STATE_PHOTO_PATH);
            lastPhotoName = savedInstanceState.getString(STATE_LAST_PHOTO_NAME);
            
            // Se havia uma foto, exibi-la
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

    }

    /**
     * Inicializa o diretório de imagens
     */
    private void initializeImageFolder() {
        imagesFolder = PhotoPathHelper.getImagesFolder(this);
        if (imagesFolder == null) {
            Log.e(TAG, "Failed to initialize images folder");
            Toast.makeText(this, "Erro ao inicializar pasta de imagens", Toast.LENGTH_SHORT).show();
        } else {
            Log.d(TAG, "Images folder initialized at: " + imagesFolder.getAbsolutePath());
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

    /**
     * Inicializa os launchers para capturar resultados de câmera, galeria e permissões
     */
    private void initializeActivityResultLaunchers() {
        // Launcher para câmera
        cameraLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() == RESULT_OK) {
                    handleCameraResult();
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

        // Launcher para permissão de câmera (única permissão necessária em runtime)
        cameraPermissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            isGranted -> {
                if (isGranted && pendingCameraLaunch) {
                    pendingCameraLaunch = false;
                    openCamera();
                } else if (pendingCameraLaunch) {
                    pendingCameraLaunch = false;
                    Toast.makeText(this, "Permissão de câmera necessária para tirar fotos", Toast.LENGTH_LONG).show();
                }
            }
        );

        // Launcher para scanner de código de barras
        barcodeLauncher = registerForActivityResult(
            new ScanContract(),
            result -> {
                if (result.getContents() != null) {
                    if (productBarcode != null) {
                        productBarcode.setText(result.getContents());
                        Toast.makeText(this, "Código de barras: " + result.getContents(), Toast.LENGTH_SHORT).show();
                    } else {
                        Log.e(TAG, "productBarcode is null when trying to set barcode value");
                        Toast.makeText(this, "Erro: Campo de código de barras não disponível", Toast.LENGTH_SHORT).show();
                    }
                } else {
                    Toast.makeText(this, "Scan cancelado", Toast.LENGTH_SHORT).show();
                }
            }
        );
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            getOnBackPressedDispatcher().onBackPressed();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    public void addProduct(View v) {

        // Verificar se os campos foram inicializados
        if (!areFieldsInitialized()) {
            Toast.makeText(AddActivity.this, "Erro: Campos não foram carregados corretamente. Por favor, tente novamente.", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Fields not initialized in addProduct");
            finish();
            return;
        }

        if (!isValid()) {
            return;
        }

        // Verificar se o banco de dados está disponível
        if (!ensureDatabaseInitialized()) {
            Toast.makeText(AddActivity.this, "Erro: Banco de dados não disponível.", Toast.LENGTH_SHORT).show();
            return;
        }

        try {
            ContentValues insertValues = new ContentValues();
            insertValues.put("name", productName.getText().toString().trim());
            insertValues.put("amount", productAmount.getText().toString().trim());
            insertValues.put("value", CurrencyHelper.sanitizeForStorage(productValue.getText().toString()));
            insertValues.put("description", productDescription != null ? productDescription.getText().toString().trim() : "");
            
            // Novos campos com verificação null
            insertValues.put("category", productCategory != null ? productCategory.getText().toString().trim() : "");
            insertValues.put("sku", productSku != null ? productSku.getText().toString().trim() : "");
            insertValues.put("barcode", productBarcode != null ? productBarcode.getText().toString().trim() : "");
            insertValues.put("supplier", productSupplier != null ? productSupplier.getText().toString().trim() : "");
            insertValues.put("location", productLocation != null ? productLocation.getText().toString().trim() : "");
            insertValues.put("min_stock", productMinStock != null ? productMinStock.getText().toString().trim() : "");
            insertValues.put("unit", productUnit != null ? productUnit.getText().toString().trim() : "");

            if (newPhotoPath != null) {
                insertValues.put("photo", newPhotoPath);
            }

            String newUuid;
            synchronized (MainActivity.DB_LOCK) {
                newUuid = new ProductRepository(MainActivity.stock)
                        .create(insertValues, MovementRepository.CADASTRO);
            }

            if (newUuid != null) {
                setResult(RESULT_OK);
                if (MainActivity.instance != null) {
                    MainActivity.instance.markListDirty(true);
                }

                // A confirmação aparece na lista, ao voltar (MainActivity).
                
                // Verificar e agendar notificações de estoque baixo
                try {
                    LowStockScheduler.checkAndScheduleNotifications(this);
                } catch (Exception e) {
                    Log.e(TAG, "Error checking low stock notifications", e);
                }

                // finish() direto em vez de dialog: evita ficar nesta Activity com a
                // listagem desatualizada até o usuário fechar o aviso.
                if (getCallingActivity() == null) {
                    // Aberto pelo "Novo" de outra seção (Histórico, Relatórios…):
                    // volta para a lista, onde o produto aparece com a confirmação.
                    Intent home = new Intent(this, MainActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            .putExtra(MainActivity.EXTRA_MESSAGE, "Produto adicionado.");
                    startActivity(home);
                }
                finish();
            } else {
                Toast.makeText(AddActivity.this, "Erro ao adicionar produto no banco de dados.", Toast.LENGTH_SHORT).show();
                Log.e(TAG, "Failed to insert product into database");
            }

        } catch (Exception e) {
            Log.e(TAG, "Error adding product", e);
            Toast.makeText(AddActivity.this, "Erro ao adicionar produto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }

    }

    /**
     * Verifica se todos os campos obrigatórios foram inicializados
     * @return true se todos os campos obrigatórios não são null
     */
    private boolean areFieldsInitialized() {
        if (productName == null) {
            Log.e(TAG, "productName is null");
            return false;
        }
        if (productAmount == null) {
            Log.e(TAG, "productAmount is null");
            return false;
        }
        if (productValue == null) {
            Log.e(TAG, "productValue is null");
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
                CurrencyHelper.setCurrencySymbol(AddActivity.this, selected);
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
            SQLiteDatabase db = LocalDb.open(this);
            if (db != null && db.isOpen()) {
                MainActivity.stock = db;
                return true;
            }
            
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error ensuring database initialized", e);
            return false;
        }
    }

    public boolean isValid() {

        // Verificação adicional de segurança
        if (!areFieldsInitialized()) {
            Log.e(TAG, "Cannot validate: fields not initialized");
            Toast.makeText(this, "Erro interno: campos não inicializados.", Toast.LENGTH_LONG).show();
            return false;
        }

        boolean nameOk;
        try {
            String name = productName.getText().toString().trim();

            if (name.isEmpty() || name.equals("null")) {
                nameOk = FormValidation.check(nameLayout, true, "Informe o nome do produto.");
            } else {
                // Verificar se o produto já existe (com tratamento de erro)
                boolean duplicate = false;
                try {
                    duplicate = MainActivity.instance != null
                            && MainActivity.instance.productAlreadyExists(name);
                } catch (Exception e) {
                    Log.e(TAG, "Error checking if product exists", e);
                    // Não bloquear a validação por este erro
                }
                nameOk = FormValidation.check(nameLayout, duplicate,
                        "Já existe um produto com este nome.");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product name", e);
            nameOk = FormValidation.check(nameLayout, true, "Não foi possível validar o nome.");
        }

        boolean amountOk;
        try {
            String amount = productAmount.getText().toString().trim();
            amountOk = FormValidation.check(amountLayout, amount.isEmpty() || amount.equals("null"),
                    "Informe a quantidade.");
        } catch (Exception e) {
            Log.e(TAG, "Error validating product amount", e);
            amountOk = FormValidation.check(amountLayout, true, "Não foi possível validar a quantidade.");
        }

        boolean valueOk;
        try {
            String value = productValue.getText().toString().trim();
            valueOk = FormValidation.check(valueLayout, value.isEmpty() || value.equals("null"),
                    "Informe o valor.");
        } catch (Exception e) {
            Log.e(TAG, "Error validating product value", e);
            valueOk = FormValidation.check(valueLayout, true, "Não foi possível validar o valor.");
        }

        boolean allValid = nameOk && amountOk && valueOk;
        if (!allValid) {
            FormValidation.focusFirstError(scrollView, nameLayout, amountLayout, valueLayout);
        }
        return allValid;

    }

    public void cancelAdd(View v) {
        if (discardGuard != null) {
            discardGuard.confirmLeave();
        } else {
            finish();
        }
    }

    public void addTakeCameraPhoto(View v) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            pendingCameraLaunch = true;
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
            return;
        }
        openCamera();
    }

    public void addTakeGalleryPhoto(View v) {
        // O Android Photo Picker não exige permissão de acesso à mídia (API 19+ via AndroidX)
        openGallery();
    }

    /**
     * Abre a câmera usando FileProvider com validações robustas
     */
    private void openCamera() {
        try {
            // Validar que a pasta de imagens está inicializada
            if (imagesFolder == null) {
                Log.w(TAG, "imagesFolder is null, reinitializing");
                initializeImageFolder();
                
                if (imagesFolder == null) {
                    Toast.makeText(this, "Erro: Não foi possível criar pasta de imagens", Toast.LENGTH_SHORT).show();
                    return;
                }
            }

            Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);

            String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
            lastPhotoName = "es_" + timeStamp + ".jpg";
            File imageFile = new File(imagesFolder, lastPhotoName);

            Log.d(TAG, "Creating photo file at: " + imageFile.getAbsolutePath());

            // Usar FileProvider para criar URI segura
            Uri photoUri = FileProvider.getUriForFile(
                this,
                getApplicationContext().getPackageName() + ".fileprovider",
                imageFile
            );

            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            try {
                cameraLauncher.launch(cameraIntent);
                Log.d(TAG, "Camera intent launched successfully");
            } catch (android.content.ActivityNotFoundException e) {
                Log.e(TAG, "No camera app available", e);
                Toast.makeText(this, "Nenhum aplicativo de câmera disponível", Toast.LENGTH_SHORT).show();
            }

        } catch (IllegalArgumentException e) {
            Log.e(TAG, "FileProvider error - check fileprovider configuration", e);
            Toast.makeText(this, "Erro de configuração ao abrir câmera", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Erro ao abrir câmera: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao abrir câmera", e);
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
     * Processa o resultado da câmera com verificações de segurança
     */
    private void handleCameraResult() {
        try {
            // Validar que os objetos necessários não são nulos
            if (imagesFolder == null) {
                Log.e(TAG, "imagesFolder is null in handleCameraResult, attempting to reinitialize");
                initializeImageFolder();
                
                if (imagesFolder == null) {
                    Toast.makeText(this, "Erro: Pasta de imagens não disponível", Toast.LENGTH_SHORT).show();
                    return;
                }
            }
            
            if (lastPhotoName == null || lastPhotoName.isEmpty()) {
                Log.e(TAG, "lastPhotoName is null or empty in handleCameraResult");
                Toast.makeText(this, "Erro: Nome da foto não foi definido", Toast.LENGTH_SHORT).show();
                return;
            }

            // Criar o arquivo com validações
            File imgFile = new File(imagesFolder, lastPhotoName);
            Log.d(TAG, "Checking for photo at: " + imgFile.getAbsolutePath());

            if (imgFile.exists()) {
                newPhotoPath = imgFile.getAbsolutePath();
                if (discardGuard != null) discardGuard.markDirty();
                displayPhoto(newPhotoPath);
                Log.d(TAG, "Photo saved successfully at: " + newPhotoPath);
            } else {
                Log.e(TAG, "Photo file does not exist at: " + imgFile.getAbsolutePath());
                Toast.makeText(this, "Erro: Foto não foi salva pela câmera", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Log.e(TAG, "Exception in handleCameraResult", e);
            Toast.makeText(this, "Erro ao processar foto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
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
        String copiedPath = PhotoPathHelper.copyUriToAppFolder(this, selectedImage);
        if (copiedPath != null) {
            newPhotoPath = copiedPath;
            if (discardGuard != null) discardGuard.markDirty();
            displayPhoto(copiedPath);
        } else {
            Toast.makeText(this, "Erro ao carregar imagem", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Exibe a foto no ImageView a partir de um caminho de arquivo
     */
    private void displayPhoto(String photoPath) {
        try {
            if (productPhoto == null) {
                Log.e(TAG, "productPhoto is null, cannot display photo");
                Toast.makeText(this, "Erro: Campo de foto não disponível", Toast.LENGTH_SHORT).show();
                return;
            }

            ImageLoadHelper.loadDetailImage(this, photoPath, productPhoto);
            
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
            if (productPhoto == null) {
                Log.e(TAG, "productPhoto is null, cannot display photo from URI");
                Toast.makeText(this, "Erro: Campo de foto não disponível", Toast.LENGTH_SHORT).show();
                return;
            }

            ImageLoadHelper.loadDetailImageFromUri(this, uri, productPhoto);
            
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
        if (productPhoto == null) {
            Log.e(TAG, "productPhoto is null, cannot setup click listener");
            return;
        }

        productPhoto.setOnClickListener(v -> {
            try {
                File file = new File(photoPath);
                
                // Usar FileUriHelper para criar URI segura
                Uri photoUri = FileUriHelper.getUriForFile(AddActivity.this, file);
                
                if (photoUri == null) {
                    Toast.makeText(AddActivity.this, "Erro ao criar referência para foto", Toast.LENGTH_SHORT).show();
                    Log.e(TAG, "Failed to create URI for photo viewer");
                    return;
                }
                
                // Verificar se a URI é segura
                if (!FileUriHelper.isUriSafe(photoUri)) {
                    Toast.makeText(AddActivity.this, "Erro de segurança ao abrir foto", Toast.LENGTH_SHORT).show();
                    Log.e(TAG, "Created URI is not safe for photo viewer: " + photoUri);
                    return;
                }
                
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(photoUri, IMAGE_TYPE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(intent);
            } catch (android.os.FileUriExposedException e) {
                Log.e(TAG, "FileUriExposedException when opening photo viewer", e);
                Toast.makeText(AddActivity.this, "Erro de segurança ao abrir foto. Por favor, atualize o aplicativo.", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Log.e(TAG, "Error opening photo viewer", e);
                Toast.makeText(AddActivity.this, "Erro ao abrir visualizador de foto", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * Configura o listener para visualizar a foto em tela cheia (versão URI)
     */
    private void setupPhotoClickListenerUri(Uri uri) {
        if (productPhoto == null) {
            Log.e(TAG, "productPhoto is null, cannot setup click listener for URI");
            return;
        }

        productPhoto.setOnClickListener(v -> {
            try {
                // Verificar se a URI é segura
                if (!FileUriHelper.isUriSafe(uri)) {
                    Toast.makeText(AddActivity.this, "Erro de segurança ao abrir foto", Toast.LENGTH_SHORT).show();
                    Log.e(TAG, "URI is not safe for sharing: " + uri);
                    return;
                }
                
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, IMAGE_TYPE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(intent);
            } catch (android.os.FileUriExposedException e) {
                Log.e(TAG, "FileUriExposedException when opening photo viewer from URI", e);
                Toast.makeText(AddActivity.this, "Erro de segurança ao abrir foto. Por favor, atualize o aplicativo.", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Log.e(TAG, "Error opening photo viewer from URI", e);
                Toast.makeText(AddActivity.this, "Erro ao abrir visualizador de foto", Toast.LENGTH_SHORT).show();
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