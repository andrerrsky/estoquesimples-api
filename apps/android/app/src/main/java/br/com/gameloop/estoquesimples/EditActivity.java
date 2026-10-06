package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.photos.ImageOptimizer;
import br.com.gameloop.estoquesimples.photos.PhotoFiles;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.ProductRepository;
import br.com.gameloop.estoquesimples.data.Quantities;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import com.google.android.material.textfield.TextInputLayout;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import androidx.activity.result.PickVisualMediaRequest;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class EditActivity extends BaseActivity {

    /** Quantidade carregada do banco ao abrir a tela, para saber se ela mudou ao salvar. */
    private double originalAmount = 0d;

    private ImageView photo;
    private TextView name;
    private TextView amount;
    private TextView value;
    private Spinner currencySpinner;
    private TextInputLayout nameLayout;
    private TextInputLayout amountLayout;
    private TextInputLayout valueLayout;
    private TextInputLayout unitLayout;
    private ScrollView scrollView;
    private TextView description;
    private TextView category;
    private TextView sku;
    private TextView barcode;
    private TextView supplier;
    private TextView location;
    private TextView minStock;
    private TextView unit;
    private DiscardGuard discardGuard;

    public String productName;

    /**
     * Identificador estável do produto em edição.
     *
     * Resolvido uma única vez ao abrir a tela. Guardar o nome não serve:
     * renomear o produto mudaria a chave no meio da própria edição, que é
     * exatamente como o histórico ficava órfão.
     */
    private String productUuid;

    private File imagesFolder;
    private String lastPhotoName;
    private String newPhotoPath;
    /** Foto que o produto tinha ao abrir a tela (para limpar o arquivo ao trocar/remover). */
    private String originalPhotoPath;
    /** O usuário pediu para remover a foto do produto. */
    private boolean removePhoto;
    /** Otimização de foto em andamento (fora da thread principal). */
    private boolean photoBusy;
    private Button removePhotoButton;

    // Constantes
    private static final String TAG = "EditActivity";
    private static final String IMAGE_TYPE = "image/*";
    private static final String ERROR_DISPLAY_PHOTO = "Erro ao exibir foto";
    
    // Keys para salvar estado
    private static final String STATE_PHOTO_PATH = "photoPath";
    private static final String STATE_REMOVE_PHOTO = "removePhoto";
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
        removePhotoButton = findViewById(R.id.editRemovePhoto);
        if (removePhotoButton != null) {
            removePhotoButton.setOnClickListener(v -> removeCurrentPhoto());
        }
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
        FieldSuggestions.attach(MainActivity.stock,
                (android.widget.AutoCompleteTextView) findViewById(R.id.editCategory),
                (android.widget.AutoCompleteTextView) findViewById(R.id.editUnit),
                (android.widget.AutoCompleteTextView) findViewById(R.id.editSupplier));
        currencySpinner = (Spinner) findViewById(R.id.editCurrencySpinner);
        nameLayout = findViewById(R.id.editNameLayout);
        amountLayout = findViewById(R.id.editAmountLayout);
        valueLayout = findViewById(R.id.editValueLayout);
        unitLayout = findViewById(R.id.editUnitLayout);
        scrollView = findViewById(R.id.editScrollView);

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

        name.setText(productName);

        // Carregar dados do produto com tratamento de erro
        if (!getItemValuesByName(productName)) {
            Toast.makeText(EditActivity.this, "Erro ao carregar dados do produto.", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        getSupportActionBar().setTitle("Editar produto");

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
            if (savedInstanceState.getBoolean(STATE_REMOVE_PHOTO, false)) {
                removeCurrentPhoto();
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

    }

    /**
     * Inicializa o diretório de imagens
     */
    private void initializeImageFolder() {
        imagesFolder = PhotoPathHelper.getImagesFolder(this);
        if (imagesFolder == null) {
            Log.e(TAG, "CRITICAL: Failed to initialize images folder");
            Toast.makeText(this, "Erro crítico: Não foi possível inicializar pasta de imagens", Toast.LENGTH_LONG).show();
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
        outState.putBoolean(STATE_REMOVE_PHOTO, removePhoto);
    }

    /** Tira a foto do produto (efeito só ao salvar) e mostra o ícone padrão. */
    private void removeCurrentPhoto() {
        removePhoto = true;
        newPhotoPath = null;
        if (photo != null) {
            photo.setImageResource(R.drawable.ic_camera);
            photo.setOnClickListener(null);
        }
        if (removePhotoButton != null) {
            removePhotoButton.setVisibility(View.GONE);
        }
        if (discardGuard != null) discardGuard.markDirty();
    }

    private void showRemovePhotoButton(boolean show) {
        if (removePhotoButton != null) {
            removePhotoButton.setVisibility(show ? View.VISIBLE : View.GONE);
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
                    if (barcode != null) {
                        Analytics.track(this, "barcode.scanned", Analytics.props("context", "edit"));
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

    /**
     * Normaliza uma quantidade armazenada para exibição no campo de edição:
     * remove o ".0" de inteiros e não usa separador de milhar (o texto é
     * gravado bruto ao salvar). Retorna "0" para valores nulos/vazios.
     */
    private static String formatAmountForEdit(String stored) {
        if (stored == null || stored.trim().isEmpty() || stored.equalsIgnoreCase("null")) {
            return "0";
        }
        // Mesmo formato da lista ("2,5"), não o cru do banco ("2.5"): a tela
        // de edição era a única com ponto decimal ao lado de "39,90".
        return CurrencyHelper.formatQuantity(CurrencyHelper.parseCurrency(stored, 0));
    }

    private static final int MENU_SAVE = 9001;

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        // "Salvar" também no topo: o formulário tem duas telas e meia de
        // altura e o botão do rodapé só aparece depois de rolar tudo.
        menu.add(android.view.Menu.NONE, MENU_SAVE, android.view.Menu.NONE, "Salvar")
                .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            getOnBackPressedDispatcher().onBackPressed();
            return true;
        }
        if (item.getItemId() == MENU_SAVE) {
            editProduct(null);
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

        productUuid = new ProductRepository(MainActivity.stock).findUuidByName(productName);
        if (productUuid == null) {
            Log.e(TAG, "Produto sem identificador: " + productName);
            return false;
        }

        Cursor cursor = null;
        try {
            cursor = MainActivity.stock.rawQuery(
                "SELECT description, amount, value, photo, category, sku, barcode, supplier, location, min_stock, unit "
                    + "FROM Estoque WHERE uuid=?",
                new String[]{productUuid}
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
                String amountForEdit = formatAmountForEdit(columnAmount);
                amount.setText(amountForEdit);
                // Precisa nascer do MESMO texto exibido no campo, não do valor
                // bruto do banco: formatAmountForEdit arredonda para 2 casas
                // (DecimalFormat "0.##"). Comparar o bruto (ex.: 10.125) com o
                // que sai do campo ao salvar sem tocar em nada (10.13) disparava
                // o diálogo de motivo e um evento de histórico por um produto
                // que o usuário nunca mudou — só para quantidades com 3+ casas
                // decimais (unidades como kg/litro).
                originalAmount = Quantities.parse(amountForEdit);
                // "49.9" cru do banco virava um campo que não parecia dinheiro;
                // o mesmo formato da lista ("49,90") deixa claro o que se edita.
                value.setText(CurrencyHelper.formatNumber(CurrencyHelper.parseCurrency(columnValue, 0.0)));
                category.setText(columnCategory != null ? columnCategory : "");
                sku.setText(columnSku != null ? columnSku : "");
                barcode.setText(columnBarcode != null ? columnBarcode : "");
                supplier.setText(columnSupplier != null ? columnSupplier : "");
                location.setText(columnLocation != null ? columnLocation : "");
                // Mínimo não cadastrado fica vazio, não "0" (o card mostra "-").
                minStock.setText(CurrencyHelper.parseCurrency(columnMinStock, 0) > 0
                        ? formatAmountForEdit(columnMinStock) : "");
                unit.setText(columnUnit != null ? columnUnit : "");

                // Carregar foto se disponível (com migração de caminhos legados)
                originalPhotoPath = PhotoPathHelper.isEmptyPhotoReference(columnPhoto) ? null : columnPhoto;
                if (!PhotoPathHelper.isEmptyPhotoReference(columnPhoto)) {
                    showRemovePhotoButton(true);
                    try {
                        if (photo == null) {
                            Log.e(TAG, "photo field is null, cannot display photo");
                        } else {
                            String displayPath = columnPhoto;
                            if (PhotoPathHelper.needsMigration(this, columnPhoto)) {
                                String migrated = PhotoPathHelper.migrateStoredPath(this, columnPhoto);
                                if (migrated != null && !migrated.equals(columnPhoto)
                                        && PhotoPathHelper.isInAppFolder(this, migrated)) {
                                    displayPath = migrated;
                                    newPhotoPath = migrated;
                                    ContentValues photoUpdate = new ContentValues();
                                    photoUpdate.put("photo", migrated);
                                    MainActivity.stock.update("Estoque", photoUpdate, "uuid=?", new String[]{productUuid});
                                }
                            }
                            ImageLoadHelper.loadDetailImage(this, displayPath, photo);
                            if (PhotoPathHelper.isContentUri(displayPath)) {
                                setupPhotoClickListenerUri(Uri.parse(displayPath));
                            } else {
                                setupPhotoClickListener(displayPath);
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

    @Override
    protected void onPostCreate(Bundle savedInstanceState) {
        super.onPostCreate(savedInstanceState);
        // Depois do onCreate, que já preencheu os campos com o produto: a
        // partir daqui qualquer mudança conta como alteração não salva.
        discardGuard = new DiscardGuard(this, "Descartar alterações?");
        discardGuard.watch(name, amount, value, description, category, sku, barcode, supplier,
                location, minStock, unit);

        if (getIntent() != null && getIntent().getBooleanExtra("fixQuantity", false) && amountLayout != null) {
            // Veio do selo "quantidade quebrada": já rola até a quantidade com a
            // explicação, em vez de abrir o formulário genérico no topo.
            FormValidation.check(amountLayout, true, Unidades.mensagemFracao(unit.getText().toString()));
            FormValidation.focusFirstError(scrollView, amountLayout);
            amount.postDelayed(() -> {
                amount.requestFocus();
                if (amount instanceof android.widget.EditText) {
                    ((android.widget.EditText) amount).selectAll();
                }
            }, 400);
        }
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
            return;
        }

        // Verificar se o banco de dados está disponível
        if (!ensureDatabaseInitialized()) {
            Toast.makeText(EditActivity.this, "Erro: Banco de dados não disponível.", Toast.LENGTH_SHORT).show();
            return;
        }

        double targetAmount = Quantities.parse(
                amount.getText().toString().replace(" ", "").trim());

        // Mudar a quantidade por aqui é, na prática, um ajuste de estoque —
        // só que sem o diálogo de Entrada/Saída, ninguém perguntava o motivo.
        // O histórico ficava com um evento "edicao" mudo, indistinguível de
        // uma correção de cadastro. Perguntar aqui também fecha essa lacuna.
        if (Double.compare(targetAmount, originalAmount) != 0) {
            promptAdjustmentNote(targetAmount);
        } else {
            saveProduct(targetAmount, null);
        }
    }

    private void promptAdjustmentNote(double targetAmount) {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (getResources().getDisplayMetrics().density * 16);
        container.setPadding(padding, padding, padding, padding);

        TextInputLayout noteLayout = FormValidation.addField(container,
                "Motivo do ajuste (opcional)",
                android.text.InputType.TYPE_CLASS_TEXT
                        | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        final EditText inputNote = noteLayout.getEditText();

        new AlertDialog.Builder(this)
                .setTitle("Quantidade alterada")
                .setMessage("De " + formatAmountForEdit(Quantities.forStorage(originalAmount))
                        + " para " + formatAmountForEdit(Quantities.forStorage(targetAmount))
                        + ". Isso fica registrado no histórico como um ajuste.\n\n"
                        + "Nada foi salvo ainda — as outras alterações desta tela continuam aqui.")
                .setView(container)
                // "Voltar e revisar" em vez de "Cancelar": nada foi gravado até
                // aqui, e "Cancelar" ao lado de outros campos editados (nome,
                // preço) sugeria perder a tela inteira, não só a quantidade.
                .setNegativeButton("Voltar e revisar", (dialog, which) -> dialog.dismiss())
                .setPositiveButton("Salvar", (dialog, which) -> {
                    String note = inputNote == null ? "" : inputNote.getText().toString().trim();
                    saveProduct(targetAmount, note.isEmpty() ? null : note);
                })
                .show();
    }

    private void saveProduct(double targetAmount, String adjustmentNote) {
        if (photoBusy) {
            Toast.makeText(this, "Preparando a foto… tente salvar em instantes.", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            ContentValues updateValues = new ContentValues();
            updateValues.put("name", name.getText().toString().trim());
            String valorDigitado = value.getText().toString().trim();
            updateValues.put("value", valorDigitado.isEmpty() ? "0" : CurrencyHelper.sanitizeForStorage(valorDigitado));
            updateValues.put("description", description != null ? description.getText().toString().trim() : "");
            
            // Novos campos com verificação null
            updateValues.put("category", category != null ? category.getText().toString().trim() : "");
            updateValues.put("sku", sku != null ? sku.getText().toString().trim() : "");
            updateValues.put("barcode", barcode != null ? barcode.getText().toString().trim() : "");
            updateValues.put("supplier", supplier != null ? supplier.getText().toString().trim() : "");
            updateValues.put("location", location != null ? location.getText().toString().trim() : "");
            updateValues.put("min_stock", minStock != null ? minStock.getText().toString().trim() : "");
            String unidadeDigitada = unit != null ? unit.getText().toString().trim() : "";
            updateValues.put("unit", unidadeDigitada.isEmpty() ? "un" : unidadeDigitada);

            if (newPhotoPath != null) {
                updateValues.put("photo", newPhotoPath);
            } else if (removePhoto) {
                updateValues.putNull("photo");
            }

            // Atualização endereçada pelo identificador estável: renomear o
            // produto deixa de desligá-lo do próprio histórico, e produtos
            // homônimos deixam de ser alterados juntos.
            boolean saved;
            String amountError = null;
            synchronized (MainActivity.DB_LOCK) {
                SQLiteDatabase db = MainActivity.stock;
                db.beginTransaction();
                try {
                    saved = new ProductRepository(db).update(productUuid, updateValues);
                    if (saved) {
                        MovementRepository.Result adjustment = new MovementRepository(db)
                                .setAbsolute(productUuid, MovementRepository.EDICAO,
                                        targetAmount, adjustmentNote);
                        if (!adjustment.success) {
                            saved = false;
                            amountError = adjustment.message;
                        }
                    }
                    if (saved) {
                        db.setTransactionSuccessful();
                    }
                } finally {
                    db.endTransaction();
                }
            }

            if (amountError != null) {
                Toast.makeText(EditActivity.this, amountError, Toast.LENGTH_LONG).show();
                return;
            }

            if (saved) {
                // A foto antiga só some do aparelho se nenhum produto a usa mais.
                if (originalPhotoPath != null
                        && (removePhoto || (newPhotoPath != null && !newPhotoPath.equals(originalPhotoPath)))) {
                    synchronized (MainActivity.DB_LOCK) {
                        PhotoFiles.deleteIfUnreferenced(MainActivity.stock,
                                PhotoPathHelper.getImagesFolder(this), originalPhotoPath);
                    }
                }
                Analytics.track(this, "product.updated");
                setResult(RESULT_OK);
                if (MainActivity.instance != null) {
                    // Busca e filtro ficam; a lista rola até o produto editado.
                    MainActivity.instance.showProductAfterSave(name.getText().toString().trim(), false);
                }

                // A confirmação aparece na lista, ao voltar (MainActivity).
                
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
            Toast.makeText(this, "Erro interno: campos não inicializados.", Toast.LENGTH_LONG).show();
            return false;
        }

        boolean nameOk;
        try {
            String nameText = name.getText().toString();
            nameOk = FormValidation.check(nameLayout,
                    nameText == null || nameText.isEmpty() || nameText.equals("null"),
                    "Informe o nome do produto.");
        } catch (Exception e) {
            Log.e(TAG, "Error validating product name", e);
            nameOk = FormValidation.check(nameLayout, true, "Não foi possível validar o nome.");
        }

        boolean amountOk;
        try {
            String amountText = amount.getText().toString();
            amountOk = FormValidation.check(amountLayout,
                    amountText == null || amountText.isEmpty() || amountText.equals("null"),
                    "Informe a quantidade.");
            // Sem isso, um valor negativo só era rejeitado depois que o
            // usuário já tinha respondido ao diálogo de motivo do ajuste —
            // uma volta perdida para um erro que dá para pegar aqui.
            if (amountOk) {
                amountOk = FormValidation.check(amountLayout,
                        Quantities.parse(amountText.replace(" ", "").trim()) < 0d,
                        "A quantidade não pode ser negativa.");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error validating product amount", e);
            amountOk = FormValidation.check(amountLayout, true, "Não foi possível validar a quantidade.");
        }

        try {
            String unidadeDigitada = unit.getText().toString();
            if (!Unidades.valida(unidadeDigitada)) {
                amountOk = FormValidation.check(unitLayout, true, "Escolha uma unidade da lista (un, kg, g, L, ml, caixa, pacote…).") && amountOk;
            } else {
                FormValidation.check(unitLayout, false, null);
            }
        } catch (Exception ignored) {
        }
        try {
            String unidade = unit.getText().toString();
            double qtd = CurrencyHelper.parseCurrency(amount.getText().toString().trim(), 0);
            if (amountOk && Unidades.inteira(unidade) && Unidades.fracionada(qtd)) {
                amountOk = FormValidation.check(amountLayout, true, Unidades.mensagemFracao(unidade));
            }
        } catch (Exception ignored) {
        }

        boolean valueOk;
        try {
            // Valor é opcional (ver AddActivity).
            valueOk = FormValidation.check(valueLayout, false, null);
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

    public void editTakeCameraPhoto(View v) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            pendingCameraLaunch = true;
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
            return;
        }
        openCamera();
    }

    public void editTakeGalleryPhoto(View v) {
        // O Android Photo Picker não exige permissão de acesso à mídia (API 19+ via AndroidX)
        openGallery();
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
            } catch (android.content.ActivityNotFoundException e) {
                Log.e(TAG, "No camera app available", e);
                Toast.makeText(this, "Nenhum aplicativo de câmera disponível", Toast.LENGTH_LONG).show();
                lastPhotoName = null;
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
                // Reduz e recodifica (WebP, até 1280 px / 250 KB) fora da thread
                // principal; sem isso a foto de 12 MP ficaria como está.
                photoBusy = true;
                ImageOptimizer.importCameraFileAsync(this, imgFile, path -> {
                    photoBusy = false;
                    if (isFinishing() || isDestroyed()) {
                        return;
                    }
                    removePhoto = false;
                    newPhotoPath = path;
                    if (discardGuard != null) discardGuard.markDirty();
                    displayPhoto(newPhotoPath);
                    Log.d(TAG, "Photo saved successfully at: " + newPhotoPath);
                    Toast.makeText(this, "Foto capturada com sucesso", Toast.LENGTH_SHORT).show();
                });
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
        // A cópia passa pelo otimizador (fora da thread principal).
        photoBusy = true;
        ImageOptimizer.importUriAsync(this, selectedImage, copiedPath -> {
            photoBusy = false;
            if (isFinishing() || isDestroyed()) {
                return;
            }
            if (copiedPath != null) {
                removePhoto = false;
                newPhotoPath = copiedPath;
                if (discardGuard != null) discardGuard.markDirty();
                displayPhoto(copiedPath);
            } else {
                Toast.makeText(this, "Erro ao carregar imagem", Toast.LENGTH_SHORT).show();
            }
        });
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

            ImageLoadHelper.loadDetailImage(this, photoPath, photo);
            showRemovePhotoButton(true);
            
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

            ImageLoadHelper.loadDetailImageFromUri(this, uri, photo);
            
            setupPhotoClickListenerUri(uri);
        } catch (Exception e) {
            Toast.makeText(this, ERROR_DISPLAY_PHOTO, Toast.LENGTH_SHORT).show();
            Log.e(TAG, ERROR_DISPLAY_PHOTO, e);
        }
    }

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
        options.setCaptureActivity(ScannerActivity.class);
        
        barcodeLauncher.launch(options);
    }

}
