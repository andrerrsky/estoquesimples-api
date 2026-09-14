package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.ProductRepository;
import br.com.gameloop.estoquesimples.data.SyncMeta;
import br.com.gameloop.estoquesimples.billing.LegacyProBilling;
import br.com.gameloop.estoquesimples.sync.SyncBootstrap;

import android.content.ContentValues;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.view.inputmethod.InputMethodManager;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.appcompat.app.AlertDialog;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.android.material.bottomnavigation.BottomNavigationView;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import androidx.annotation.NonNull;
import androidx.appcompat.widget.SearchView;
import android.view.Menu;
import android.view.MenuItem;

import java.util.ArrayList;

public class MainActivity extends BaseActivity {

    public static MainActivity instance;

    public static SQLiteDatabase stock;

    /** Serializa acesso ao SQLite (UI + migração de fotos em background). */
    public static final Object DB_LOCK = new Object();

    public ListView listView;
    public CustomListView listAdapter;
    public SearchView searchView;
    private ActivityResultLauncher<ScanOptions> barcodeSearchLauncher;

    public ArrayList<String> names;
    public ArrayList<String> descriptions;
    public ArrayList<String> amounts;
    public ArrayList<String> values;
    public ArrayList<String> photos;
    public ArrayList<String> categories;
    public ArrayList<String> skus;
    public ArrayList<String> barcodes;
    public ArrayList<String> suppliers;
    public ArrayList<String> locations;
    public ArrayList<String> minStocks;
    public ArrayList<String> units;

    // Listas filtradas para a busca
    public ArrayList<String> filteredNames;
    public ArrayList<String> filteredDescriptions;
    public ArrayList<String> filteredAmounts;
    public ArrayList<String> filteredValues;
    public ArrayList<String> filteredPhotos;
    public ArrayList<String> filteredCategories;
    public ArrayList<String> filteredSkus;
    public ArrayList<String> filteredBarcodes;
    public ArrayList<String> filteredSuppliers;
    public ArrayList<String> filteredLocations;
    public ArrayList<String> filteredMinStocks;
    public ArrayList<String> filteredUnits;

    public BottomNavigationView bottomNavigationView;

    public SharedPreferences prefs;
    public SharedPreferences.Editor prefsEditor;

    // Premium management
    private PremiumManager premiumManager;

    /** Pedido de refresh ao voltar de Add/Edit/Import (evita atualizar Activity pausada). */
    private boolean pendingListRefresh;
    private boolean pendingClearSearch;

    private final ActivityResultLauncher<Intent> addProductLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (result.getResultCode() == RESULT_OK) {
                    pendingMessage = "Produto adicionado.";
                    pendingClearSearch = true;
                    // O produto novo não pode nascer escondido atrás do filtro.
                    lowStockOnly = false;
                }
                pendingListRefresh = true;
            });

    private final ActivityResultLauncher<Intent> editProductLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (result.getResultCode() == RESULT_OK) {
                    // A busca fica: quem editou "queijo" quer ver o queijo editado.
                    pendingMessage = "Produto atualizado.";
                }
                pendingListRefresh = true;
            });

    // Sem isso o leitor abria e o próprio scanner mostrava um erro em inglês
    // ("the Android camera encountered a problem") quando a câmera era negada.
    private final ActivityResultLauncher<String> cameraPermissionForSearch =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted) {
                    View button = findViewById(R.id.scanSearchButton);
                    if (button != null) button.performClick();
                } else {
                    com.google.android.material.snackbar.Snackbar sb = Feedback.make(this,
                            "Sem acesso à câmera. Permita nas configurações do app para ler códigos.",
                            com.google.android.material.snackbar.Snackbar.LENGTH_LONG);
                    if (sb != null) {
                        sb.setDuration(8000);
                        sb.setAction("Configurações", v -> startActivity(
                                new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                        android.net.Uri.fromParts("package", getPackageName(), null))));
                        sb.show();
                    }
                }
            });

    /** Confirmação a mostrar quando a tela voltar ao primeiro plano. */
    private String pendingMessage;
    // Um booleano, não texto livre: a MainActivity é exportada (launcher) e um
    // extra de texto viraria um jeito de qualquer app escrever na nossa tela.
    public static final String EXTRA_PRODUCT_ADDED = "br.com.gameloop.estoquesimples.PRODUCT_ADDED";

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_PRODUCT_ADDED, false)) {
            pendingMessage = "Produto adicionado.";
            pendingClearSearch = true;
            lowStockOnly = false;
            pendingListRefresh = true;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Precisa vir antes de super.onCreate(): é isso que troca o tema desta
        // Activity de volta para o CustomActionBarTheme assim que a splash sai.
        androidx.core.splashscreen.SplashScreen.installSplashScreen(this);

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        CurrencyHelper.warmUp(this);

        applyEmptyState(null);

        TextView chipAll = findViewById(R.id.chipAll);
        TextView chipLowStock = findViewById(R.id.chipLowStock);
        if (chipAll != null && chipLowStock != null) {
            chipAll.setOnClickListener(v -> setLowStockOnly(false));
            chipLowStock.setOnClickListener(v -> setLowStockOnly(true));
        }

        View emptyActionClear = findViewById(R.id.emptyActionClear);
        if (emptyActionClear != null) {
            emptyActionClear.setOnClickListener(v -> {
                if (lowStockOnly) {
                    setLowStockOnly(false);
                    return;
                }
                if (searchView != null) {
                    searchView.setQuery("", false);
                    releaseSearchFocus();
                }
            });
        }

        View emptyActionAdd = findViewById(R.id.emptyActionAdd);
        if (emptyActionAdd != null) {
            emptyActionAdd.setOnClickListener(v -> showAddActivity());
        }

        View emptyActionSettings = findViewById(R.id.emptyActionSettings);
        if (emptyActionSettings != null) {
            emptyActionSettings.setOnClickListener(v -> showSettingsActivity());
        }

        instance = this;

        // Voltar com uma busca ou filtro ativo limpa a busca/filtro; só um
        // segundo Voltar, com a lista inteira à vista, sai do app.
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                boolean searching = searchView != null && searchView.getQuery().length() > 0;
                if (searching) {
                    // Só a busca: o filtro escolhido continua.
                    searchView.setQuery("", false);
                    releaseSearchFocus();
                    filterList("");
                    return;
                }
                if (lowStockOnly) {
                    setLowStockOnly(false);
                    return;
                }
                long now = android.os.SystemClock.elapsedRealtime();
                if (now - lastBackPress > 2500) {
                    // Sair sem querer no meio do trabalho custa caro; um segundo
                    // toque em seguida confirma.
                    lastBackPress = now;
                    Feedback.make(MainActivity.this, "Toque Voltar de novo para sair",
                            com.google.android.material.snackbar.Snackbar.LENGTH_SHORT).show();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_PRODUCT_ADDED, false)) {
            pendingMessage = "Produto adicionado.";
        }

        // Configurar Picasso com otimizações de memória para evitar crashes com imagens grandes
        ImageLoadHelper.configurePicasso(this);

        // Inicializar gerenciadores
        premiumManager = PremiumManager.getInstance(this);

        // Inicializar SharedPreferences ANTES de usar
        prefs = getApplicationContext().getSharedPreferences("EstoqueSimplesPrefs", 0);
        
        openOrCreateDB();
        prepareList();
        getListValues();
        updateList();
        
        // Reconhecer compra PRO antiga, se houver
        startLegacyProRecognition();
        
        // Iniciar verificação de estoque baixo e agendamento de notificações
        LowStockScheduler.checkAndScheduleNotifications(this);

        // Decide em segundo plano se este aparelho sincroniza. Enquanto a
        // resposta não chega, o app opera exatamente como sempre operou.
        SyncBootstrap.start(this);

        // SearchView setup:
        searchView = (SearchView) findViewById(R.id.searchView);
        if (searchView != null) {
            searchView.setIconifiedByDefault(false);
            searchView.setIconified(false);
            searchView.clearFocus();
            // O clearFocus() acima roda antes do layout: o próprio setIconified(false)
            // pede foco no EditText interno, e a janela reatribui esse foco assim que
            // aparece na tela, abrindo o teclado sozinho. Repetir clearFocus() em
            // post() garante que ele rode depois dessa disputa, já com a Activity
            // visível — e esconde o teclado caso ele já tenha chegado a aparecer.
            searchView.post(() -> {
                searchView.clearFocus();
                InputMethodManager imm =
                        (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) {
                    imm.hideSoftInputFromWindow(searchView.getWindowToken(), 0);
                }
            });
            flattenSearchViewPadding(searchView);
            View closeButton = searchView.findViewById(androidx.appcompat.R.id.search_close_btn);
            if (closeButton != null) {
                // O "X" padrão limpa e abre o teclado; aqui limpar é terminar a busca.
                closeButton.setOnClickListener(v -> {
                    searchView.setQuery("", false);
                    releaseSearchFocus();
                });
            }
            searchView.setOnQueryTextListener(new SearchView.OnQueryTextListener() {
                @Override
                public boolean onQueryTextSubmit(String query) {
                    filterList(query);
                    return true;
                }

                @Override
                public boolean onQueryTextChange(String newText) {
                    if (listAdapter != null) {
                        listAdapter.collapseAll();
                    }
                    filterList(newText);
                    return true;
                }
            });
        } else {
            Log.e("MainActivity", "searchView is null");
        }

        // Buscar produto escaneando o código de barras cadastrado nele.
        barcodeSearchLauncher = registerForActivityResult(
                new ScanContract(),
                result -> {
                    if (result.getContents() != null && searchView != null) {
                        searchView.setQuery(result.getContents(), true);
                    }
                }
        );

        Button scanSearchButton = findViewById(R.id.scanSearchButton);
        if (scanSearchButton != null) {
            scanSearchButton.setOnClickListener(v -> {
                if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    cameraPermissionForSearch.launch(android.Manifest.permission.CAMERA);
                    return;
                }
                ScanOptions options = new ScanOptions();
                options.setDesiredBarcodeFormats(ScanOptions.ALL_CODE_TYPES);
                options.setPrompt("Escaneie o código de barras do produto");
                options.setBeepEnabled(true);
                options.setBarcodeImageEnabled(false);
                options.setOrientationLocked(false);
        options.setCaptureActivity(ScannerActivity.class);
                barcodeSearchLauncher.launch(options);
            });
        }

        // Bottom Menu:
        bottomNavigationView = (BottomNavigationView) findViewById(R.id.bottomNavigation);
        if (bottomNavigationView != null) {
            bottomNavigationView.setBackgroundColor(ContextCompat.getColor(getApplicationContext(), R.color.colorActionBar));
            
            bottomNavigationView.setOnItemSelectedListener(new BottomNavigationView.OnItemSelectedListener() {
                @Override
                public boolean onNavigationItemSelected(@NonNull MenuItem item) {
                    int itemId = item.getItemId();
                    
                    if (itemId == R.id.navigation_home) {
                        return true;
                    } else if (itemId == R.id.navigation_new) {
                        showAddActivity();
                        return true;
                    } else if (itemId == R.id.navigation_history) {
                        showHistoryActivity();
                        return true;
                    } else if (itemId == R.id.navigation_reports) {
                        showReportsActivity();
                        return true;
                    } else if (itemId == R.id.navigation_import) {
                        showImportActivity();
                        return true;
                    }
                    return false;
                }
            });
        } else {
            Log.e("MainActivity", "bottomNavigationView is null");
        }

        if(!prefs.getBoolean("welcomeMsgAlreadyDisplayed", false)) {
            showWelcomeMessage();
            prefsEditor = prefs.edit();
            prefsEditor.putBoolean("welcomeMsgAlreadyDisplayed", true);
            prefsEditor.commit();
        }

    }

    /**
     * Abre o banco local.
     *
     * A criação de tabelas e a evolução do schema saíram daqui e passaram a
     * viver em {@link LocalDb}. Antes, cada tela repetia os CREATE e os ALTER
     * por conta própria, e o schema real de um aparelho dependia de qual tela
     * o usuário tinha aberto. Agora existe uma versão de schema explícita e um
     * caminho de migração único.
     */
    public void openOrCreateDB() {
        try {
            stock = LocalDb.open(this);

            if (stock == null) {
                Log.e("MainActivity", "Failed to open or create database");
                Toast.makeText(this, "Erro crítico: Não foi possível inicializar o banco de dados", Toast.LENGTH_LONG).show();
                return;
            }

            Log.d("MainActivity", "Database initialized successfully");
            migrateProductPhotosAsync();

        } catch (Exception e) {
            Log.e("MainActivity", "Error initializing database", e);
            Toast.makeText(this, "Erro ao inicializar banco de dados: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Migra fotos legadas (caminhos públicos ou content://) para a pasta privada do app.
     * Executado em background para não bloquear a UI.
     */
    private void migrateProductPhotosAsync() {
        if (stock == null || !stock.isOpen()) {
            return;
        }
        final SQLiteDatabase db = stock;
        new Thread(() -> {
            try {
                int migrated;
                synchronized (DB_LOCK) {
                    migrated = PhotoPathHelper.migrateAllPhotosInDatabase(MainActivity.this, db);
                }
                if (migrated > 0) {
                    Log.i("MainActivity", "Migrated " + migrated + " product photos to app storage");
                    runOnUiThread(() -> {
                        if (!isFinishing() && listAdapter != null) {
                            updateList();
                        }
                    });
                }
            } catch (Exception e) {
                Log.e("MainActivity", "Error migrating product photos", e);
            }
        }).start();
    }


    public void prepareList() {

        names = new ArrayList<>();
        descriptions = new ArrayList<>();
        amounts = new ArrayList<>();
        values = new ArrayList<>();
        photos = new ArrayList<>();
        categories = new ArrayList<>();
        skus = new ArrayList<>();
        barcodes = new ArrayList<>();
        suppliers = new ArrayList<>();
        locations = new ArrayList<>();
        minStocks = new ArrayList<>();
        units = new ArrayList<>();

        filteredNames = new ArrayList<>();
        filteredDescriptions = new ArrayList<>();
        filteredAmounts = new ArrayList<>();
        filteredValues = new ArrayList<>();
        filteredPhotos = new ArrayList<>();
        filteredCategories = new ArrayList<>();
        filteredSkus = new ArrayList<>();
        filteredBarcodes = new ArrayList<>();
        filteredSuppliers = new ArrayList<>();
        filteredLocations = new ArrayList<>();
        filteredMinStocks = new ArrayList<>();
        filteredUnits = new ArrayList<>();

        listAdapter = new CustomListView(this, filteredNames, filteredAmounts, filteredValues, filteredPhotos, filteredCategories, filteredSkus, filteredLocations, filteredMinStocks, filteredUnits, filteredSuppliers, filteredBarcodes, filteredDescriptions);

        listView = (ListView) findViewById(R.id.listView);
        listView.setEmptyView(findViewById(R.id.empty_list_item));
        listView.setAdapter(listAdapter);

    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bottomNavigationView != null) {
            bottomNavigationView.setSelectedItemId(R.id.navigation_home);
        }

        if (searchView != null) {
            // Garante que a barra de busca continue expandida após trocas de foco/IME.
            searchView.setIconified(false);
            if (pendingClearSearch) {
                searchView.setQuery("", false);
                pendingClearSearch = false;
            }
            // setIconified(false) acima pede foco no EditText interno por conta
            // própria — mesmo quando não há busca para limpar. Sem isso, voltar de
            // qualquer tela reabre o teclado sozinho. clearFocus() em post() roda
            // depois dessa disputa, já com a Activity em primeiro plano.
            searchView.post(() -> {
                searchView.clearFocus();
                InputMethodManager imm =
                        (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) {
                    imm.hideSoftInputFromWindow(searchView.getWindowToken(), 0);
                }
            });
        }

        // Sempre recarrega ao voltar (cadastro/edição/importação) e em todo resume.
        if (listAdapter != null || pendingListRefresh) {
            pendingListRefresh = false;
            updateList();
            revealPendingProduct();
        }

        updateConflictsBanner();

        if (pendingMessage != null) {
            String message = pendingMessage;
            pendingMessage = null;
            Feedback.show(this, message);
        }
    }

    /**
     * Mostra o aviso de conflitos de sincronização pendentes, se houver.
     *
     * A contagem vem de {@link SyncMeta#CONFLITOS_PENDENTES}, atualizada pela
     * própria {@link ConflictsActivity} sempre que a lista é carregada ou um
     * conflito é resolvido — nenhuma chamada de rede extra acontece aqui. Sem
     * este aviso na tela inicial, um conflito só aparecia para quem lembrasse
     * de abrir "Conta e sincronização" por conta própria.
     */
    private void updateConflictsBanner() {
        View banner = findViewById(R.id.conflictsBanner);
        if (banner == null || stock == null || !stock.isOpen()) {
            return;
        }
        long pendentes = new SyncMeta(stock).getLong(SyncMeta.CONFLITOS_PENDENTES, 0L);
        if (pendentes <= 0) {
            banner.setVisibility(View.GONE);
            return;
        }
        TextView texto = findViewById(R.id.conflictsBannerText);
        if (texto != null) {
            texto.setText(pendentes == 1
                    ? "1 conflito de sincronização precisa da sua decisão"
                    : pendentes + " conflitos de sincronização precisam da sua decisão");
        }
        banner.setVisibility(View.VISIBLE);
        banner.setOnClickListener(v -> startActivity(new Intent(this, ConflictsActivity.class)));
    }


    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (instance == this) {
            instance = null;
        }
    }

    /**
     * Marca que a listagem precisa ser recarregada ao voltar para a Main.
     * Preferível a chamar {@link #updateList()} com a Activity pausada.
     */
    public void markListDirty(boolean clearSearch) {
        pendingListRefresh = true;
        if (clearSearch) {
            pendingClearSearch = true;
        }
    }

    private long lastBackPress;

    /** Produto a mostrar (rolado e expandido) na próxima atualização da lista. */
    private String pendingShowName;

    /**
     * Depois de salvar um produto a lista voltava numa posição qualquer e o
     * produto salvo não aparecia — "cadê o que acabei de cadastrar?". Agora
     * a lista rola até ele e o mostra expandido.
     */
    public void showProductAfterSave(String name, boolean isNew) {
        pendingShowName = name;
        pendingListRefresh = true;
        if (isNew) {
            // Produto novo pode não bater com a busca nem estar com estoque baixo.
            pendingClearSearch = true;
            lowStockOnly = false;
        }
    }

    private void revealPendingProduct() {
        if (pendingShowName == null || listView == null || listAdapter == null) {
            return;
        }
        final String name = pendingShowName;
        pendingShowName = null;
        int index = filteredNames.indexOf(name);
        if (index < 0) {
            return;
        }
        listAdapter.expand(name);
        final int position = index;
        listView.post(() -> listView.setSelectionFromTop(position, 0));
    }

    /**
     * Tira o foco (e o teclado) da busca e devolve o foco à raiz. Chamado ao
     * fechar os diálogos de Entrada/Saída e ao limpar a busca pelo "X".
     */
    public void releaseSearchFocus() {
        View root = findViewById(R.id.mainRoot);
        Runnable release = () -> {
            if (searchView != null) {
                searchView.clearFocus();
            }
            if (root != null) {
                root.requestFocus();
            }
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.hideSoftInputFromWindow(getWindow().getDecorView().getWindowToken(), 0);
            }
        };
        release.run();
        if (root != null) {
            // De novo depois que a janela recuperar o foco: é aí que o sistema
            // tentava reapontar o teclado para a busca.
            root.post(release);
        }
    }

    /** Filtro "Estoque baixo" da tela inicial. */
    private boolean lowStockOnly = false;

    private static boolean isLowStock(String amountStr, String minStockStr) {
        double amount = CurrencyHelper.parseCurrency(amountStr, 0);
        if (amount <= 0) {
            // Saldo zero é "sem estoque" mesmo sem mínimo cadastrado.
            return true;
        }
        if (minStockStr == null || minStockStr.isEmpty() || minStockStr.equals("null")) {
            return false;
        }
        double min = CurrencyHelper.parseCurrency(minStockStr, 0);
        return min > 0 && amount <= min;
    }

    private int countMatching(boolean lowOnly) {
        String q = fold(searchView != null ? searchView.getQuery().toString() : "");
        int n = 0;
        for (int i = 0; i < names.size(); i++) {
            if (!matchesQuery(i, q)) continue;
            if (lowOnly && !isLowStock(amounts.get(i), minStocks.get(i))) continue;
            n++;
        }
        return n;
    }

    /**
     * Chips "Todos" / "Estoque baixo (n)" acima da lista. Os relatórios já
     * sabiam quantos produtos estavam abaixo do mínimo, mas a Início — onde o
     * dono do negócio passa o dia — não dava nenhum atalho para chegar neles.
     */
    private void updateFilterChips() {
        View filterBar = findViewById(R.id.filterBar);
        TextView chipAll = findViewById(R.id.chipAll);
        TextView chipLow = findViewById(R.id.chipLowStock);
        if (filterBar == null || chipAll == null || chipLow == null) {
            return;
        }
        // Contagens relativas ao que está sendo buscado.
        int low = countMatching(true);
        int all = countMatching(false);
        // A barra fica fixa enquanto houver produtos: sumir e voltar
        // conforme a busca parecia um defeito.
        if (names.isEmpty()) {
            filterBar.setVisibility(View.GONE);
            lowStockOnly = false;
            return;
        }
        filterBar.setVisibility(View.VISIBLE);
        chipAll.setText("Todos (" + all + ")");
        chipLow.setText("Estoque baixo (" + low + ")");
        chipAll.setSelected(!lowStockOnly);
        chipLow.setSelected(lowStockOnly);
    }

    private void setLowStockOnly(boolean enabled) {
        if (lowStockOnly == enabled) {
            return;
        }
        lowStockOnly = enabled;
        updateFilterChips();
        filterList(searchView != null ? searchView.getQuery().toString() : "");
    }

    public void updateList() {
        if (isFinishing()) {
            return;
        }
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runOnUiThread(this::updateList);
            return;
        }
        if (listView == null) {
            return;
        }

        getListValues();
        updateFilterChips();
        filterList(searchView != null ? searchView.getQuery().toString() : "");

    }

    /**
     * Atualiza o adapter sem trocá-lo. Recriar o adapter a cada movimentação
     * (setAdapter) fazia a ListView perder o foco para o campo de busca, que
     * abria o teclado sozinho depois de cada Entrada/Saída, e jogava fora o
     * estado expandido dos cards. As listas filtradas são as mesmas
     * instâncias que o adapter recebeu no prepareList().
     */
    private void refreshAdapterInPlace() {
        if (listAdapter == null) {
            listAdapter = new CustomListView(this, filteredNames, filteredAmounts, filteredValues, filteredPhotos, filteredCategories, filteredSkus, filteredLocations, filteredMinStocks, filteredUnits, filteredSuppliers, filteredBarcodes, filteredDescriptions);
            listView.setAdapter(listAdapter);
            return;
        }
        listAdapter.notifyDataSetChanged();
    }

    /**
     * O estado vazio tem duas situações bem diferentes: nenhum produto
     * cadastrado (onboarding) e busca sem resultado. Mostrar "Cadastre seu
     * primeiro produto" para quem tem 40 produtos e digitou errado fazia
     * parecer que o cadastro tinha sumido.
     */
    private void applyEmptyState(String query) {
        TextView title = findViewById(R.id.emptyTitle);
        TextView message = findViewById(R.id.emptyMessage);
        View actionAdd = findViewById(R.id.emptyActionAdd);
        View actionSettings = findViewById(R.id.emptyActionSettings);
        View actionClear = findViewById(R.id.emptyActionClear);
        if (title == null || message == null) {
            return;
        }
        boolean searching = query != null && !query.trim().isEmpty();
        int hiddenByChip = lowStockOnly ? countMatching(false) : 0;
        TextView clearLabel = findViewById(R.id.emptyActionClearLabel);
        if (lowStockOnly && hiddenByChip > 0) {
            // O chip "Estoque baixo" escondeu o que a busca achou: dizer isso,
            // em vez de "nada corresponde" com o chip mostrando "Todos (1)".
            title.setText("Nenhum com estoque baixo");
            message.setText(hiddenByChip == 1
                    ? "1 produto corresponde à busca, mas não está com estoque baixo."
                    : hiddenByChip + " produtos correspondem à busca, mas nenhum está com estoque baixo.");
            if (clearLabel != null) clearLabel.setText("Ver todos");
            searching = true;
        } else if (lowStockOnly) {
            title.setText("Nenhum produto com estoque baixo");
            message.setText("Tudo acima do mínimo por aqui.");
            if (clearLabel != null) clearLabel.setText("Ver todos");
            searching = true;
        } else if (searching) {
            title.setText("Nenhum produto encontrado");
            message.setText("Nada corresponde a \u201c" + query.trim() + "\u201d. Tente outra palavra, "
                    + "ou busque por SKU, código de barras ou categoria.");
            if (clearLabel != null) clearLabel.setText("Limpar busca");
        } else {
            title.setText("Nenhum produto cadastrado");
            message.setText("Cadastre seu primeiro produto para começar a controlar o "
                    + "estoque. Se preferir, dê uma olhada nas configurações do app antes.");
        }
        if (actionAdd != null) actionAdd.setVisibility(searching ? View.GONE : View.VISIBLE);
        if (actionSettings != null) actionSettings.setVisibility(searching ? View.GONE : View.VISIBLE);
        if (actionClear != null) actionClear.setVisibility(searching ? View.VISIBLE : View.GONE);
    }

    public void filterList(String query) {
        if (listView == null) {
            return;
        }
        
        clearFilteredArrays();
        
        if ((query == null || query.trim().isEmpty()) && !lowStockOnly) {
            // Se a busca está vazia, mostrar todos os itens
            copyToFilteredLists();
        } else {
            // Filtrar itens baseado na busca e no chip de estoque baixo
            String searchQuery = fold(query);
            
            for (int i = 0; i < names.size(); i++) {
                if (lowStockOnly && !isLowStock(amounts.get(i), minStocks.get(i))) {
                    continue;
                }
                if (matchesQuery(i, searchQuery)) {
                    
                    filteredNames.add(names.get(i));
                    filteredDescriptions.add(descriptions.get(i));
                    filteredAmounts.add(amounts.get(i));
                    filteredValues.add(values.get(i));
                    filteredPhotos.add(photos.get(i));
                    filteredCategories.add(categories.get(i));
                    filteredSkus.add(skus.get(i));
                    filteredBarcodes.add(barcodes.get(i));
                    filteredSuppliers.add(suppliers.get(i));
                    filteredLocations.add(locations.get(i));
                    filteredMinStocks.add(minStocks.get(i));
                    filteredUnits.add(units.get(i));
                }
            }
        }
        
        refreshAdapterInPlace();
        applyEmptyState(query);
        updateFilterChips();
    }

    /**
     * Texto sem acento e em minúsculas para comparar: "oleo" precisa achar
     * "Óleo de Soja" — metade de uma mercearia tem acento e o teclado do
     * celular muitas vezes não os digita.
     */
    static String fold(String text) {
        if (text == null) return "";
        String base = java.text.Normalizer.normalize(text.trim(), java.text.Normalizer.Form.NFD);
        return base.replaceAll("\\p{M}+", "").toLowerCase(java.util.Locale.ROOT);
    }

    private boolean matchesQuery(int i, String foldedQuery) {
        if (foldedQuery.isEmpty()) return true;
        return fold(names.get(i)).contains(foldedQuery)
                || fold(categories.get(i)).contains(foldedQuery)
                || fold(skus.get(i)).contains(foldedQuery)
                || fold(barcodes.get(i)).contains(foldedQuery)
                || fold(locations.get(i)).contains(foldedQuery)
                || fold(descriptions.get(i)).contains(foldedQuery);
    }

    public void copyToFilteredLists() {
        clearFilteredArrays();
        filteredNames.addAll(names);
        filteredDescriptions.addAll(descriptions);
        filteredAmounts.addAll(amounts);
        filteredValues.addAll(values);
        filteredPhotos.addAll(photos);
        filteredCategories.addAll(categories);
        filteredSkus.addAll(skus);
        filteredBarcodes.addAll(barcodes);
        filteredSuppliers.addAll(suppliers);
        filteredLocations.addAll(locations);
        filteredMinStocks.addAll(minStocks);
        filteredUnits.addAll(units);
    }

    public void clearFilteredArrays() {
        filteredNames.clear();
        filteredDescriptions.clear();
        filteredAmounts.clear();
        filteredValues.clear();
        filteredPhotos.clear();
        filteredCategories.clear();
        filteredSkus.clear();
        filteredBarcodes.clear();
        filteredSuppliers.clear();
        filteredLocations.clear();
        filteredMinStocks.clear();
        filteredUnits.clear();
    }

    @SafeVarargs
    private static void sortByName(ArrayList<String> names, ArrayList<String>... columns) {
        java.text.Collator collator = java.text.Collator.getInstance(new java.util.Locale("pt", "BR"));
        collator.setStrength(java.text.Collator.PRIMARY);
        Integer[] order = new Integer[names.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        java.util.Arrays.sort(order, (a, b) -> collator.compare(
                names.get(a) == null ? "" : names.get(a), names.get(b) == null ? "" : names.get(b)));
        ArrayList<ArrayList<String>> all = new ArrayList<>();
        all.add(names);
        java.util.Collections.addAll(all, columns);
        for (ArrayList<String> col : all) {
            ArrayList<String> copy = new ArrayList<>(col);
            for (int i = 0; i < order.length; i++) col.set(i, copy.get(order[i]));
        }
    }

    public void getListValues() {
        // Carrega em listas temporárias e só troca se a query tiver sucesso,
        // evitando listagem vazia quando há falha transitória (ex.: lock do SQLite).
        ArrayList<String> newNames = new ArrayList<>();
        ArrayList<String> newDescriptions = new ArrayList<>();
        ArrayList<String> newAmounts = new ArrayList<>();
        ArrayList<String> newValues = new ArrayList<>();
        ArrayList<String> newPhotos = new ArrayList<>();
        ArrayList<String> newCategories = new ArrayList<>();
        ArrayList<String> newSkus = new ArrayList<>();
        ArrayList<String> newBarcodes = new ArrayList<>();
        ArrayList<String> newSuppliers = new ArrayList<>();
        ArrayList<String> newLocations = new ArrayList<>();
        ArrayList<String> newMinStocks = new ArrayList<>();
        ArrayList<String> newUnits = new ArrayList<>();

        if (stock == null || !stock.isOpen()) {
            Log.e("MainActivity", "Database is not available in getListValues");
            Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
            return;
        }

        Cursor cursor = null;
        try {
            synchronized (DB_LOCK) {
                cursor = stock.rawQuery(
                        "SELECT name, description, amount, value, photo, category, sku, barcode, supplier, location, min_stock, unit "
                                + "FROM Estoque WHERE " + LocalDb.ACTIVE_PRODUCTS + " ORDER BY name COLLATE NOCASE ASC",
                        null);

                if (cursor != null && cursor.moveToFirst()) {
                    do {
                        newNames.add(cursor.getString(0));
                        newDescriptions.add(cursor.getString(1));
                        newAmounts.add(cursor.getString(2));
                        newValues.add(cursor.getString(3));
                        newPhotos.add(cursor.getString(4));
                        newCategories.add(cursor.getString(5));
                        newSkus.add(cursor.getString(6));
                        newBarcodes.add(cursor.getString(7));
                        newSuppliers.add(cursor.getString(8));
                        newLocations.add(cursor.getString(9));
                        newMinStocks.add(cursor.getString(10));
                        newUnits.add(cursor.getString(11));
                    } while (cursor.moveToNext());
                    // Ordem alfabética com regras do português (acentos e
                    // cedilha no lugar certo): COLLATE NOCASE do SQLite só
                    // entende ASCII e jogava "Açúcar" depois de "Amaciante".
                    sortByName(newNames, newDescriptions, newAmounts, newValues, newPhotos, newCategories,
                            newSkus, newBarcodes, newSuppliers, newLocations, newMinStocks, newUnits);
                }
            }

            clearArrays();
            names.addAll(newNames);
            descriptions.addAll(newDescriptions);
            amounts.addAll(newAmounts);
            values.addAll(newValues);
            photos.addAll(newPhotos);
            categories.addAll(newCategories);
            skus.addAll(newSkus);
            barcodes.addAll(newBarcodes);
            suppliers.addAll(newSuppliers);
            locations.addAll(newLocations);
            minStocks.addAll(newMinStocks);
            units.addAll(newUnits);
        } catch (Exception e) {
            Log.e("MainActivity", "Error loading product list", e);
            Toast.makeText(this, "Erro ao carregar lista de produtos", Toast.LENGTH_SHORT).show();
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }

    }

    public void clearArrays() {

        names.clear();
        descriptions.clear();
        amounts.clear();
        values.clear();
        photos.clear();
        categories.clear();
        skus.clear();
        barcodes.clear();
        suppliers.clear();
        locations.clear();
        minStocks.clear();
        units.clear();

    }

    public void deleteProduct(String productName) {

        final String finalProductName = productName;

        new AlertDialog.Builder(this)
                .setTitle("Excluir produto?")
                .setMessage("\u201c" + productName + "\u201d sai da lista e dos relatórios atuais. "
                        + "As movimentações já registradas continuam no histórico.")
                .setIcon(R.drawable.ic_delete)
                .setPositiveButton("Excluir", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int whichButton) {
                        try {
                            // Verificar se o banco de dados está disponível
                            if (stock == null || !stock.isOpen()) {
                                Log.e("MainActivity", "Database is not available in deleteProduct");
                                Toast.makeText(MainActivity.this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
                                return;
                            }
                            
                            // Exclusão suave por identificador estável.
                            //
                            // Apagar a linha deixava o histórico órfão de forma
                            // definitiva, e apagar por nome removia junto todos
                            // os produtos homônimos. Marcando como excluído, o
                            // produto some das listas, os relatórios históricos
                            // continuam corretos e nada é perdido.
                            boolean rowsDeleted;
                            final String deletedUuid;
                            synchronized (DB_LOCK) {
                                ProductRepository products = new ProductRepository(stock);
                                deletedUuid = products.findUuidByName(finalProductName);
                                rowsDeleted = deletedUuid != null && products.softDelete(deletedUuid);
                            }

                            if (rowsDeleted) {
                                updateList();
                                // Única ação destrutiva sem volta: como a exclusão é
                                // suave, restaurar é seguro e viaja pelo sync.
                                com.google.android.material.snackbar.Snackbar undo = Feedback.make(
                                        MainActivity.this, "Produto excluído.",
                                        com.google.android.material.snackbar.Snackbar.LENGTH_LONG);
                                if (undo != null) {
                                    undo.setDuration(CustomListView.UNDO_DURATION_MS);
                                    undo.setAction("Desfazer", v -> {
                                        boolean restored;
                                        synchronized (DB_LOCK) {
                                            restored = new ProductRepository(stock).restore(deletedUuid);
                                        }
                                        updateList();
                                        Feedback.show(MainActivity.this, restored
                                                ? "Produto restaurado." : "Não foi possível restaurar.");
                                    });
                                    undo.show();
                                }
                                
                                // Verificar e atualizar agendamento de notificações de estoque baixo
                                LowStockScheduler.checkAndScheduleNotifications(MainActivity.this);
                            } else {
                                Toast.makeText(MainActivity.this, "Erro: Produto não encontrado.", Toast.LENGTH_SHORT).show();
                                Log.w("MainActivity", "No rows deleted for product: " + finalProductName);
                            }
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, "Erro ao remover produto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                            Log.e("MainActivity", "Error deleting product", e);
                        }
                    }})
                .setNegativeButton("Cancelar", null).show();

    }

    public boolean productAlreadyExists(String productName) {
        if (productName == null || productName.trim().isEmpty()) {
            return false;
        }

        // Verificar se o banco de dados está disponível
        if (stock == null || !stock.isOpen()) {
            Log.e("MainActivity", "Database is not available in productAlreadyExists");
            return false;
        }

        try {
            synchronized (DB_LOCK) {
                return new ProductRepository(stock).existsByName(productName);
            }
        } catch (Exception e) {
            Log.e("MainActivity", "Error checking if product exists", e);
            return false;
        }
    }

    public void showAddActivity() {

        Intent intent = new Intent(this, AddActivity.class);
        addProductLauncher.launch(intent);

    }

    public void showEditActivity(String productName) {

        Intent intent = new Intent(this, EditActivity.class);
        intent.putExtra("productName", productName);
        editProductLauncher.launch(intent);

    }

    public void showReportsActivity() {

        Intent intent = new Intent(this, ReportsActivity.class);
        startActivity(intent);
        overridePendingTransition(0, 0);

    }

    public void showImportActivity() {

        Intent intent = new Intent(this, ImportActivity.class);
        startActivity(intent);
        overridePendingTransition(0, 0);

    }

    public void showHistoryActivity() {
        Intent intent = new Intent(this, HistoryActivity.class);
        startActivity(intent);
        overridePendingTransition(0, 0);
    }

    public void showSettingsActivity() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
    }

    public void showAnalyticsActivity() {
        Intent intent = new Intent(this, AnalyticsActivity.class);
        startActivity(intent);
    }

    public void showWelcomeMessage() {

        AlertDialog alertDialog = new AlertDialog.Builder(MainActivity.this).create();
        alertDialog.setTitle("Bem-vindo ao Estoque Simples");
        alertDialog.setMessage("Cadastre seus produtos e registre cada entrada e saída pelos botões do "
                + "próprio card. O estoque fica salvo neste aparelho, sem precisar de internet ou "
                + "cadastro.\n\nDúvidas ou problemas? Fale com a gente em ⋮ > Sobre.");
        alertDialog.setButton(AlertDialog.BUTTON_NEUTRAL, "Começar",
                new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int which) {
                        dialog.dismiss();
                    }
                });
        alertDialog.show();

    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.options_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int itemId = item.getItemId();
        
        if (itemId == R.id.menu_bulk_edit) {
            showBulkEditDialog();
            return true;
        } else if (itemId == R.id.menu_analytics) {
            showAnalyticsActivity();
            return true;
        } else if (itemId == R.id.menu_about) {
            showAboutActivity();
            return true;
        } else if (itemId == R.id.menu_account) {
            startActivity(new Intent(this, AccountActivity.class));
            return true;
        } else if (itemId == R.id.menu_subscription) {
            SubscriptionActivity.open(this);
            return true;
        } else if (itemId == R.id.menu_settings) {
            showSettingsActivity();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    public void showAboutActivity() {
        Intent intent = new Intent(this, AboutActivity.class);
        startActivity(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
    }
    
    /**
     * Consulta a Play Store por uma compra única antiga, sem oferecer venda.
     */
    private void startLegacyProRecognition() {
        if (premiumManager != null && premiumManager.isPro()) {
            return;
        }
        LegacyProBilling.runQuery(this, false, (result, message) -> { });
    }
    
    /**
     * Mostra dialog para edição em massa (FREE FEATURE)
     */
    private void showBulkEditDialog() {
        if (names.isEmpty()) {
            Toast.makeText(this, "Nenhum produto cadastrado para editar.", Toast.LENGTH_SHORT).show();
            return;
        }
        
        // Criar array de nomes de produtos
        final String[] productNames = names.toArray(new String[0]);
        final boolean[] checkedItems = new boolean[productNames.length];
        final java.util.List<String> selectedProducts = new java.util.ArrayList<>();
        
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle(R.string.bulk_edit_title);
        builder.setMultiChoiceItems(productNames, checkedItems, (dialog, which, isChecked) -> {
            if (isChecked) {
                selectedProducts.add(productNames[which]);
            } else {
                selectedProducts.remove(productNames[which]);
            }
        });
        
        builder.setPositiveButton("Editar Selecionados", (dialog, which) -> {
            if (selectedProducts.isEmpty()) {
                Toast.makeText(this, "Nenhum produto selecionado.", Toast.LENGTH_SHORT).show();
                return;
            }
            
            // Mostrar opções de edição
            showBulkEditOptionsDialog(selectedProducts);
        });
        
        builder.setNegativeButton("Cancelar", null);
        builder.show();
    }
    
    /**
     * Mostra opções de edição em massa
     */
    private void showBulkEditOptionsDialog(final java.util.List<String> selectedProducts) {
        final String[] options = {"Ajustar quantidade (+/-)", "Definir categoria", "Definir fornecedor"};
        
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Escolha a operação");
        builder.setItems(options, (dialog, which) -> {
            switch (which) {
                case 0:
                    // Ajustar quantidade
                    showBulkAdjustQuantityDialog(selectedProducts);
                    break;
                case 1:
                    // Definir categoria
                    showBulkSetCategoryDialog(selectedProducts);
                    break;
                case 2:
                    // Definir fornecedor
                    showBulkSetSupplierDialog(selectedProducts);
                    break;
            }
        });
        builder.show();
    }
    
    /**
     * Campo único dos diálogos de edição em massa, no mesmo padrão dos outros
     * diálogos do app (borda, legenda de erro, sem colar nas bordas).
     */
    private static class BulkField {
        final LinearLayout container;
        final com.google.android.material.textfield.TextInputLayout layout;

        BulkField(Context context, String hint, int inputType) {
            container = new LinearLayout(context);
            container.setOrientation(LinearLayout.VERTICAL);
            int padding = (int) (context.getResources().getDisplayMetrics().density * 16);
            container.setPadding(padding, padding / 2, padding, 0);
            layout = FormValidation.addField(container, hint, inputType);
        }

        String text() {
            return layout.getEditText() == null ? "" : layout.getEditText().getText().toString().trim();
        }
    }

    /** "Açúcar Refinado 1kg, Água Mineral 500ml e mais 3" — para a pessoa ver em quem vai mexer. */
    private static String listarNomes(java.util.List<String> nomes) {
        StringBuilder sb = new StringBuilder();
        int mostrados = Math.min(4, nomes.size());
        for (int i = 0; i < mostrados; i++) {
            if (i > 0) sb.append(", ");
            sb.append(nomes.get(i));
        }
        if (nomes.size() > mostrados) {
            sb.append(" e mais ").append(nomes.size() - mostrados);
        }
        return sb.toString();
    }

    private void showBulkInputDialog(String title, String message, String hint, int inputType,
                                     String requiredMessage, java.util.function.Consumer<String> onApply) {
        BulkField field = new BulkField(this, hint, inputType);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setView(field.container)
                .setPositiveButton("Aplicar", null)
                .setNegativeButton("Cancelar", null)
                .show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (!FormValidation.required(field.layout, requiredMessage)) {
                return;
            }
            dialog.dismiss();
            onApply.accept(field.text());
        });
    }

    /**
     * Ajusta quantidade em massa
     */
    private void showBulkAdjustQuantityDialog(final java.util.List<String> selectedProducts) {
        showBulkInputDialog("Ajustar quantidade",
                "Some ou subtraia a mesma quantidade em: " + listarNomes(selectedProducts)
                        + ". +10 adiciona, -5 remove. Dá para desfazer logo em seguida.",
                "Quantidade (+10 ou -5)",
                android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_FLAG_SIGNED
                        | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL,
                "Informe a quantidade.",
                value -> {
                    double adjustment = CurrencyHelper.parseCurrency(value, Double.NaN);
                    if (Double.isNaN(adjustment) || adjustment == 0) {
                        Toast.makeText(this, "Quantidade inválida.", Toast.LENGTH_SHORT).show();
                    } else {
                        performBulkQuantityAdjustment(selectedProducts, adjustment);
                    }
                });
    }
    
    /**
     * Define categoria em massa
     */
    private void showBulkSetCategoryDialog(final java.util.List<String> selectedProducts) {
        showBulkInputDialog("Definir categoria",
                "A categoria abaixo substitui a atual em: " + listarNomes(selectedProducts) + ".",
                "Categoria",
                android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
                "Informe a categoria.",
                category -> performBulkCategoryUpdate(selectedProducts, category));
    }
    
    /**
     * Define fornecedor em massa
     */
    private void showBulkSetSupplierDialog(final java.util.List<String> selectedProducts) {
        showBulkInputDialog("Definir fornecedor",
                "O fornecedor abaixo substitui o atual em: " + listarNomes(selectedProducts) + ".",
                "Fornecedor",
                android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_CAP_WORDS,
                "Informe o fornecedor.",
                supplier -> performBulkSupplierUpdate(selectedProducts, supplier));
    }
    
    /**
     * Executa ajuste de quantidade em massa
     */
    private void performBulkQuantityAdjustment(java.util.List<String> products, double adjustment) {
        // Verificar se o banco de dados está disponível
        if (stock == null || !stock.isOpen()) {
            Log.e("MainActivity", "Database is not available in performBulkQuantityAdjustment");
            Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
            return;
        }
        
        int updated = 0;
        ProductRepository repository = new ProductRepository(stock);
        MovementRepository movements = new MovementRepository(stock);
        final java.util.List<String> movementUuids = new ArrayList<>();

        for (String productName : products) {
            try {
                String uuid = repository.findUuidByName(productName);
                if (uuid == null) {
                    continue;
                }

                // O ajuste em massa passa pelo repositório de movimentações
                // para que a mudança de saldo também vire um evento. Alterar a
                // quantidade sem registrar o motivo é o que hoje impede
                // reconstruir o estoque a partir do histórico.
                double target = Math.max(0, repository.currentAmount(uuid) + adjustment);
                MovementRepository.Result result = movements.setAbsolute(
                        uuid, MovementRepository.AJUSTE, target, "Ajuste em massa");
                if (result.success) {
                    updated++;
                    if (result.movementUuid != null) {
                        movementUuids.add(result.movementUuid);
                    }
                }
            } catch (Exception e) {
                Log.e("MainActivity", "Error adjusting quantity for product: " + productName, e);
            }
        }
        
        updateList();
        String resumo = (adjustment > 0 ? "+" : "") + CurrencyHelper.formatQuantity(adjustment)
                + " em " + updated + (updated == 1 ? " produto." : " produtos.");
        com.google.android.material.snackbar.Snackbar undo = Feedback.make(this, resumo,
                com.google.android.material.snackbar.Snackbar.LENGTH_LONG);
        if (undo == null) {
            return;
        }
        undo.setDuration(CustomListView.UNDO_DURATION_MS);
        if (!movementUuids.isEmpty()) {
            // Um erro de digitação (+50 em vez de +5) mexia em vários saldos de
            // uma vez e reverter era um por um no Histórico.
            undo.setAction("Desfazer", v -> {
                int revertidos = 0;
                synchronized (DB_LOCK) {
                    MovementRepository repo = new MovementRepository(stock);
                    for (String movementUuid : movementUuids) {
                        if (repo.cancel(movementUuid, "Ajuste em massa desfeito").success) {
                            revertidos++;
                        }
                    }
                }
                updateList();
                Feedback.show(MainActivity.this, "Ajuste desfeito em " + revertidos
                        + (revertidos == 1 ? " produto." : " produtos."));
            });
        }
        undo.show();
    }
    
    /**
     * Executa atualização de categoria em massa
     */
    private void performBulkCategoryUpdate(java.util.List<String> products, String category) {
        // Verificar se o banco de dados está disponível
        if (stock == null || !stock.isOpen()) {
            Log.e("MainActivity", "Database is not available in performBulkCategoryUpdate");
            Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
            return;
        }
        
        int updated = 0;
        ProductRepository repository = new ProductRepository(stock);
        for (String productName : products) {
            try {
                String uuid = repository.findUuidByName(productName);
                if (uuid == null) continue;
                ContentValues values = new ContentValues();
                values.put("category", category);
                if (repository.update(uuid, values)) updated++;
            } catch (Exception e) {
                Log.e("MainActivity", "Error updating category for product: " + productName, e);
            }
        }
        
        updateList();
        Feedback.show(this, getString(R.string.bulk_edit_success, updated));
    }
    
    /**
     * Executa atualização de fornecedor em massa
     */
    private void performBulkSupplierUpdate(java.util.List<String> products, String supplier) {
        // Verificar se o banco de dados está disponível
        if (stock == null || !stock.isOpen()) {
            Log.e("MainActivity", "Database is not available in performBulkSupplierUpdate");
            Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
            return;
        }
        
        int updated = 0;
        ProductRepository repository = new ProductRepository(stock);
        for (String productName : products) {
            try {
                String uuid = repository.findUuidByName(productName);
                if (uuid == null) continue;
                ContentValues values = new ContentValues();
                values.put("supplier", supplier);
                if (repository.update(uuid, values)) updated++;
            } catch (Exception e) {
                Log.e("MainActivity", "Error updating supplier for product: " + productName, e);
            }
        }
        
        updateList();
        Feedback.show(this, getString(R.string.bulk_edit_success, updated));
    }

    private void flattenSearchViewPadding(SearchView searchView) {
        View frame = searchView.findViewById(androidx.appcompat.R.id.search_edit_frame);
        if (frame != null && frame.getLayoutParams() instanceof LinearLayout.LayoutParams) {
            LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) frame.getLayoutParams();
            lp.setMarginStart(0);
            lp.setMarginEnd(0);
            lp.leftMargin = 0;
            lp.rightMargin = 0;
            frame.setLayoutParams(lp);
        }

        View plate = searchView.findViewById(androidx.appcompat.R.id.search_plate);
        if (plate != null) {
            plate.setBackground(null);
            plate.setPadding(0, 0, 0, 0);
        }

        View mag = searchView.findViewById(androidx.appcompat.R.id.search_mag_icon);
        if (mag != null) {
            mag.setPadding(0, 0, 0, 0);
            if (mag.getLayoutParams() instanceof LinearLayout.LayoutParams) {
                LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) mag.getLayoutParams();
                lp.setMarginStart(0);
                lp.leftMargin = 0;
                mag.setLayoutParams(lp);
            }
        }
    }

}
