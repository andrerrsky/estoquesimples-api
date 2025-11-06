package br.com.gameloop.estoquesimples;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import android.os.Bundle;
import androidx.appcompat.widget.Toolbar;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.Toast;

import com.appodeal.ads.Appodeal;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import com.squareup.picasso.Picasso;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class AddActivity extends AppCompatActivity {

    private EditText productName;
    private EditText productAmount;
    private EditText productValue;
    private EditText productDescription;
    private EditText productCategory;
    private EditText productSku;
    private EditText productBarcode;
    private EditText productSupplier;
    private EditText productLocation;
    private EditText productMinStock;
    private EditText productUnit;
    private ImageView productPhoto;

    private String errorFeedback;

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
    private ActivityResultLauncher<Intent> galleryLauncher;
    private ActivityResultLauncher<String[]> permissionLauncher;
    private ActivityResultLauncher<ScanOptions> barcodeLauncher;

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
        productPhoto = (ImageView) findViewById(R.id.addPhoto);

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

        errorFeedback = "Erros encontrados:\n";

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

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

        // Configurar e mostrar o MREC do Appodeal
        initializeAppodealMrec();

    }

    /**
     * Inicializa o diretório de imagens
     */
    private void initializeImageFolder() {
        try {
            File externalFilesDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            if (externalFilesDir != null) {
                imagesFolder = new File(externalFilesDir, "EstoqueSimples");
                if (!imagesFolder.exists()) {
                    boolean created = imagesFolder.mkdirs();
                    if (!created) {
                        Log.e(TAG, "Failed to create images folder");
                    }
                }
            } else {
                Log.e(TAG, "getExternalFilesDir returned null");
                // Fallback para diretório interno
                imagesFolder = new File(getFilesDir(), "EstoqueSimples");
                if (!imagesFolder.exists()) {
                    imagesFolder.mkdirs();
                }
            }
            Log.d(TAG, "Images folder initialized at: " + imagesFolder.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Error initializing images folder", e);
            Toast.makeText(this, "Erro ao inicializar pasta de imagens", Toast.LENGTH_SHORT).show();
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

        // Launcher para galeria
        galleryLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    handleGalleryResult(result.getData());
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

    /**
     * Inicializa e exibe o anúncio MREC do Appodeal
     */
    private void initializeAppodealMrec() {
        // Verificar se o Appodeal já foi inicializado na MainActivity
        if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
            // Usar AdManager para controlar banner e MREC
            AdManager adManager = AdManager.getInstance(this);
            adManager.showBannerAds(this, R.id.appodealBannerView, R.id.appodealMrecView);
            
            Log.d(TAG, "Banner e MREC configurados na AddActivity");
        } else {
            Log.d(TAG, "Appodeal ainda não foi inicializado, anúncios não serão exibidos");
        }
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

    public void addProduct(View v) {

        // Verificar se os campos foram inicializados
        if (!areFieldsInitialized()) {
            Toast.makeText(AddActivity.this, "Erro: Campos não foram carregados corretamente. Por favor, tente novamente.", Toast.LENGTH_LONG).show();
            Log.e(TAG, "Fields not initialized in addProduct");
            finish();
            return;
        }

        if (!isValid()) {
            Toast.makeText(AddActivity.this, errorFeedback, Toast.LENGTH_LONG).show();
            errorFeedback = "Erros encontrados:\n";
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
            insertValues.put("value", productValue.getText().toString().trim());
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

            long rowId = MainActivity.stock.insert("Estoque", null, insertValues);

            if (rowId != -1) {
                // Atualizar lista se MainActivity está disponível
                if (MainActivity.instance != null) {
                    MainActivity.instance.updateList();
                }

                Toast.makeText(AddActivity.this, "Produto adicionado com sucesso!", Toast.LENGTH_LONG).show();
                
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

    public boolean isValid() {

        // Verificação adicional de segurança
        if (!areFieldsInitialized()) {
            Log.e(TAG, "Cannot validate: fields not initialized");
            errorFeedback += "\n- Erro interno: campos não inicializados;";
            return false;
        }

        boolean isValid = true;

        try {
            String name = productName.getText().toString().trim();

            if (name.isEmpty() || name.equals("null")) {
                errorFeedback += "\n- Nome do produto é invalido;";
                isValid = false;
            } else {
                // Verificar se o produto já existe (com tratamento de erro)
                try {
                    if (MainActivity.instance != null && MainActivity.instance.productAlreadyExists(name)) {
                        errorFeedback += "\n- Produto com mesmo nome já cadastrado;";
                        isValid = false;
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error checking if product exists", e);
                    // Não bloquear a validação por este erro
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product name", e);
            errorFeedback += "\n- Erro ao validar nome do produto;";
            isValid = false;
        }

        try {
            String amount = productAmount.getText().toString().trim();
            if (amount.isEmpty() || amount.equals("null")) {
                errorFeedback += "\n- Quantidade do produto é invalida;";
                isValid = false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product amount", e);
            errorFeedback += "\n- Erro ao validar quantidade do produto;";
            isValid = false;
        }

        try {
            String value = productValue.getText().toString().trim();
            if (value.isEmpty() || value.equals("null")) {
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

    public void cancelAdd(View v) {

        finish();

    }

    public void addTakeCameraPhoto(View v) {
        if (checkAndRequestPermissions(true)) {
            openCamera();
        }
    }

    public void addTakeGalleryPhoto(View v) {
        if (checkAndRequestPermissions(false)) {
            openGallery();
        }
    }

    /**
     * Verifica e solicita permissões necessárias
     * @param forCamera true se for para câmera, false para galeria
     * @return true se todas as permissões já foram concedidas
     */
    private boolean checkAndRequestPermissions(boolean forCamera) {
        List<String> permissionsNeeded = new ArrayList<>();

        // Permissão de câmera (apenas se for usar câmera)
        if (forCamera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) 
                != PackageManager.PERMISSION_GRANTED) {
            permissionsNeeded.add(Manifest.permission.CAMERA);
        }

        // Permissões de armazenamento
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ usa READ_MEDIA_IMAGES
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) 
                    != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(Manifest.permission.READ_MEDIA_IMAGES);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // Android 6 a 12 usa READ_EXTERNAL_STORAGE
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) 
                    != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(Manifest.permission.READ_EXTERNAL_STORAGE);
            }
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2 && 
                ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) 
                    != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            }
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
            
            // Verificar se há um app de câmera disponível
            if (cameraIntent.resolveActivity(getPackageManager()) == null) {
                Toast.makeText(this, "Nenhum aplicativo de câmera disponível", Toast.LENGTH_SHORT).show();
                return;
            }

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

            cameraLauncher.launch(cameraIntent);
            Log.d(TAG, "Camera intent launched successfully");

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
        Intent galleryIntent = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
        galleryLauncher.launch(galleryIntent);
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
    private void handleGalleryResult(Intent data) {
        Uri selectedImage = data.getData();
        
        if (selectedImage == null) {
            Toast.makeText(this, "Erro ao carregar esta imagem", Toast.LENGTH_SHORT).show();
            return;
        }

        Cursor cursor = null;
        try {
            String[] filePathColumn = { MediaStore.Images.Media.DATA };
            cursor = getContentResolver().query(selectedImage, filePathColumn, null, null, null);
            
            if (cursor != null && cursor.moveToFirst()) {
                int columnIndex = cursor.getColumnIndex(filePathColumn[0]);
                String picturePath = cursor.getString(columnIndex);

                if (picturePath != null && !picturePath.isEmpty()) {
                    newPhotoPath = picturePath;
                    displayPhoto(picturePath);
                } else {
                    // Se não conseguiu o caminho, usa a URI diretamente
                    newPhotoPath = selectedImage.toString();
                    displayPhotoFromUri(selectedImage);
                }
            } else {
                // Se cursor falhar, tenta usar URI diretamente
                newPhotoPath = selectedImage.toString();
                displayPhotoFromUri(selectedImage);
            }
        } catch (Exception e) {
            Toast.makeText(this, "Erro ao carregar imagem: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao processar imagem da galeria", e);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
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

            Picasso.get()
                .load("file://" + photoPath)
                .resize(1200, 1200) // Limita dimensões máximas
                .centerInside() // Mantém aspect ratio
                .onlyScaleDown() // Não aumenta imagens menores
                .placeholder(R.drawable.package_icon) // Placeholder durante carregamento
                .error(R.drawable.package_icon) // Imagem de erro caso falhe
                .into(productPhoto);
            
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

            Picasso.get()
                .load(uri)
                .resize(1200, 1200) // Limita dimensões máximas
                .centerInside() // Mantém aspect ratio
                .onlyScaleDown() // Não aumenta imagens menores
                .placeholder(R.drawable.package_icon) // Placeholder durante carregamento
                .error(R.drawable.package_icon) // Imagem de erro caso falhe
                .into(productPhoto);
            
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