package br.com.gameloop.estoquesimples;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
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

    // ActivityResultLaunchers para capturar resultados
    private ActivityResultLauncher<Intent> cameraLauncher;
    private ActivityResultLauncher<Intent> galleryLauncher;
    private ActivityResultLauncher<String[]> permissionLauncher;
    private ActivityResultLauncher<ScanOptions> barcodeLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_add);

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

        errorFeedback = "Erros encontrados:\n";

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        this.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);

        // Inicializar launchers para Activity Results
        initializeActivityResultLaunchers();

        // Criar diretório de imagens no armazenamento interno da app
        imagesFolder = new File(getExternalFilesDir(Environment.DIRECTORY_PICTURES), "EstoqueSimples");
        if (!imagesFolder.exists()) {
            imagesFolder.mkdirs();
        }

        // Configurar e mostrar o MREC do Appodeal
        initializeAppodealMrec();

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
                    productBarcode.setText(result.getContents());
                    Toast.makeText(this, "Código de barras: " + result.getContents(), Toast.LENGTH_SHORT).show();
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

        if(isValid()) {

            ContentValues insertValues = new ContentValues();
            insertValues.put("name", productName.getText().toString());
            insertValues.put("amount", productAmount.getText().toString());
            insertValues.put("value", productValue.getText().toString());
            insertValues.put("description", productDescription.getText().toString());
            
            // Novos campos
            insertValues.put("category", productCategory.getText().toString());
            insertValues.put("sku", productSku.getText().toString());
            insertValues.put("barcode", productBarcode.getText().toString());
            insertValues.put("supplier", productSupplier.getText().toString());
            insertValues.put("location", productLocation.getText().toString());
            insertValues.put("min_stock", productMinStock.getText().toString());
            insertValues.put("unit", productUnit.getText().toString());

            if(newPhotoPath != null) {
                insertValues.put("photo", newPhotoPath);
            }

            MainActivity.stock.insert("Estoque", null, insertValues);

            MainActivity.instance.updateList();

            Toast.makeText(AddActivity.this, "Produto adicionado com sucesso!", Toast.LENGTH_LONG).show();
            
            // Registrar interação para contagem de anúncios
            AdManager.getInstance(this).registerInteraction(this);
            
            // Verificar e agendar notificações de estoque baixo
            LowStockScheduler.checkAndScheduleNotifications(this);

            finish();

        } else {

            Toast.makeText(AddActivity.this, errorFeedback, Toast.LENGTH_LONG).show();
            errorFeedback = "Erros encontrados:\n";

        }

    }

    public boolean isValid() {

        boolean isValid = true;

        if(productName.getText().toString() == null || productName.getText().toString().isEmpty() || productName.getText().toString().equals("null")) {
            errorFeedback += "\n- Nome do produto é invalido;";
            isValid = false;
        }

        if(MainActivity.instance.productAlreadyExists(productName.getText().toString())) {
            errorFeedback += "\n- Produto com mesmo nome já cadastrado;";
            isValid = false;
        }

        if(productAmount.getText().toString() == null || productAmount.getText().toString().isEmpty() || productAmount.getText().toString().equals("null")) {
            errorFeedback += "\n- Quantidade do produto é invalida;";
            isValid = false;
        }

        if(productValue.getText().toString() == null || productValue.getText().toString().isEmpty() || productValue.getText().toString().equals("null")) {
            errorFeedback += "\n- Valor do produto é invalido;";
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
     * Abre a câmera usando FileProvider
     */
    private void openCamera() {
        try {
            Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());

            lastPhotoName = "es_" + timeStamp + ".jpg";
            File imageFile = new File(imagesFolder, lastPhotoName);

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
     * Processa o resultado da câmera
     */
    private void handleCameraResult() {
        File imgFile = new File(imagesFolder, lastPhotoName);

        if (imgFile.exists()) {
            newPhotoPath = imgFile.getAbsolutePath();
            displayPhoto(newPhotoPath);
        } else {
            Toast.makeText(this, "Erro ao salvar foto", Toast.LENGTH_SHORT).show();
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
            Picasso.get()
                .load("file://" + photoPath)
                .fit()
                .centerCrop()
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
            Picasso.get()
                .load(uri)
                .fit()
                .centerCrop()
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
        productPhoto.setOnClickListener(v -> {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            File file = new File(photoPath);
            Uri photoUri = FileProvider.getUriForFile(
                AddActivity.this,
                getApplicationContext().getPackageName() + ".fileprovider",
                file
            );
            intent.setDataAndType(photoUri, IMAGE_TYPE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        });
    }

    /**
     * Configura o listener para visualizar a foto em tela cheia (versão URI)
     */
    private void setupPhotoClickListenerUri(Uri uri) {
        productPhoto.setOnClickListener(v -> {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, IMAGE_TYPE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
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