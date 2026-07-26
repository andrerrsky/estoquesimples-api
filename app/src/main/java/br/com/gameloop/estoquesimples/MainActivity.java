package br.com.gameloop.estoquesimples;

import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import androidx.annotation.Nullable;
import androidx.cardview.widget.CardView;
import androidx.core.content.ContextCompat;
import androidx.appcompat.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.text.Html;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import com.appodeal.ads.Appodeal;
import com.appodeal.ads.initializing.ApdInitializationCallback;
import com.appodeal.ads.initializing.ApdInitializationError;
import com.google.android.material.bottomnavigation.BottomNavigationView;
import androidx.annotation.NonNull;
import androidx.appcompat.widget.SearchView;
import android.view.Menu;
import android.view.MenuItem;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BaseActivity {

    public static MainActivity instance;

    public static SQLiteDatabase stock;

    public ListView listView;
    public TextView emptyListItem;
    public CustomListView listAdapter;
    public SearchView searchView;

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

    private boolean appODealInitialized;
    
    // Premium and Ad management
    private PremiumManager premiumManager;
    private AdManager adManager;
    private CardView premiumCard;
    private TextView premiumCardTitle;
    private TextView premiumCardMessage;
    private Button btnPremiumCardAction;
    private ImageButton btnClosePremiumCard;
    private Handler premiumUpdateHandler;
    private Runnable premiumUpdateRunnable;

    public void onAppODealInitialized() {
        appODealInitialized = true;

        // Usar AdManager para controlar exibição de anúncios
        if (adManager != null) {
            adManager.showBannerAds(this, R.id.appodealBannerView, 0);
        }
    }

    public boolean isAppODealInitialized() {
        return appODealInitialized;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        CurrencyHelper.warmUp(this);

        emptyListItem = (TextView) findViewById(R.id.empty_list_item);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            emptyListItem.setText(Html.fromHtml("<b>Nenhum produto encontrado</b><br>Você pode começar adicionando um novo cadastro no botão <b>Novo Produto</b>" , Html.FROM_HTML_MODE_LEGACY));
        } else {
            emptyListItem.setText(Html.fromHtml("<b>Nenhum produto encontrado</b><br>Você pode começar adicionando um novo cadastro no botão <b>Novo Produto</b>"));
        }

        instance = this;

        // Configurar Picasso com otimizações de memória para evitar crashes com imagens grandes
        ImageLoadHelper.configurePicasso(this);

        // Inicializar gerenciadores
        premiumManager = PremiumManager.getInstance(this);
        adManager = AdManager.getInstance(this);

        // Inicializar premium card
        premiumCard = findViewById(R.id.premiumCard);
        premiumCardTitle = findViewById(R.id.premiumCardTitle);
        premiumCardMessage = findViewById(R.id.premiumCardMessage);
        btnPremiumCardAction = findViewById(R.id.btnPremiumCardAction);
        btnClosePremiumCard = findViewById(R.id.btnClosePremiumCard);
        
        if (btnPremiumCardAction != null) {
            btnPremiumCardAction.setOnClickListener(v -> onPremiumCardActionClicked());
        } else {
            Log.e("MainActivity", "btnPremiumCardAction is null");
        }
        
        if (btnClosePremiumCard != null) {
            btnClosePremiumCard.setOnClickListener(v -> onClosePremiumCardClicked());
        } else {
            Log.e("MainActivity", "btnClosePremiumCard is null");
        }
        
        // Inicializar SharedPreferences ANTES de usar
        prefs = getApplicationContext().getSharedPreferences("EstoqueSimplesPrefs", 0);
        
        openOrCreateDB();
        prepareList();
        getListValues();
        updateList();
        
        // Atualizar premium card
        updatePremiumCard();
        startPremiumUpdateTimer();
        
        // Iniciar verificação de estoque baixo e agendamento de notificações
        LowStockScheduler.checkAndScheduleNotifications(this);

        // SearchView setup:
        searchView = (SearchView) findViewById(R.id.searchView);
        if (searchView != null) {
            searchView.setOnQueryTextListener(new SearchView.OnQueryTextListener() {
                @Override
                public boolean onQueryTextSubmit(String query) {
                    filterList(query);
                    return true;
                }

                @Override
                public boolean onQueryTextChange(String newText) {
                    filterList(newText);
                    return true;
                }
            });
        } else {
            Log.e("MainActivity", "searchView is null");
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

        Appodeal.setBannerViewId(R.id.appodealBannerView);
        Appodeal.setMrecViewId(R.id.appodealMrecView);

        int adTypes = Appodeal.INTERSTITIAL | Appodeal.BANNER_VIEW | Appodeal.REWARDED_VIDEO | Appodeal.MREC;

        Appodeal.initialize(this, Constants.APPODEAL_KEY, adTypes, new ApdInitializationCallback() {
            @Override
            public void onInitializationFinished(@Nullable List<ApdInitializationError> errors) {
                Log.d("Appodeal", "Initialization finished. errors=" + (errors == null ? 0 : errors.size()));
                onAppODealInitialized();
            }
        });

    }

    public void openOrCreateDB() {
        try {
            stock = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
            
            if (stock == null) {
                Log.e("MainActivity", "Failed to open or create database");
                Toast.makeText(this, "Erro crítico: Não foi possível inicializar o banco de dados", Toast.LENGTH_LONG).show();
                return;
            }
            
            stock.execSQL("CREATE TABLE IF NOT EXISTS Estoque(id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR, description VARCHAR, amount VARCHAR, value VARCHAR, photo VARCHAR, category VARCHAR, sku VARCHAR, barcode VARCHAR, supplier VARCHAR, location VARCHAR, min_stock VARCHAR, unit VARCHAR);");
            // Histórico de movimentações de estoque
            stock.execSQL("CREATE TABLE IF NOT EXISTS EstoqueHistorico(id INTEGER PRIMARY KEY AUTOINCREMENT, product_name VARCHAR, change_type VARCHAR, quantity INTEGER, timestamp INTEGER, note VARCHAR);");
            
            // Adicionar colunas novas se a tabela já existir (migração)
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN category VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column category already exists");
            }
            
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN sku VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column sku already exists");
            }
            
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN barcode VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column barcode already exists");
            }
            
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN supplier VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column supplier already exists");
            }
            
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN location VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column location already exists");
            }
            
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN min_stock VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column min_stock already exists");
            }
            
            try {
                stock.execSQL("ALTER TABLE Estoque ADD COLUMN unit VARCHAR");
            } catch (Exception e) { 
                Log.d("MainActivity", "Column unit already exists");
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
                int migrated = PhotoPathHelper.migrateAllPhotosInDatabase(MainActivity.this, db);
                if (migrated > 0) {
                    Log.i("MainActivity", "Migrated " + migrated + " product photos to app storage");
                    runOnUiThread(() -> {
                        if (listAdapter != null) {
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

        listAdapter = new CustomListView(this, filteredNames, filteredAmounts, filteredValues, filteredPhotos, filteredCategories, filteredSkus, filteredLocations, filteredMinStocks, filteredUnits);

        listView = (ListView) findViewById(R.id.listView);
        listView.setEmptyView(findViewById(R.id.empty_list_item));
        listView.setAdapter(listAdapter);

    }

    @Override
    protected void onResume() {
        super.onResume();
        bottomNavigationView.setSelectedItemId(R.id.navigation_home);

        // Recriar a lista para refletir mudanças de configuração (ex.: exibir/ocultar imagens)
        if (listAdapter != null) {
            updateList();
        }

        // Atualizar premium card e anúncios
        updatePremiumCard();
        if (adManager != null) {
            adManager.showBannerAds(this, R.id.appodealBannerView, 0);
        }
    }
    
    @Override
    protected void onPause() {
        super.onPause();
        stopPremiumUpdateTimer();
    }
    
    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopPremiumUpdateTimer();
    }

    public void updateList() {

        getListValues();
        
        // Aplicar filtro atual se houver busca ativa
        if (searchView != null && searchView.getQuery().length() > 0) {
            filterList(searchView.getQuery().toString());
        } else {
            // Se não há busca, mostrar todos os itens
            copyToFilteredLists();
            listAdapter = new CustomListView(this, filteredNames, filteredAmounts, filteredValues, filteredPhotos, filteredCategories, filteredSkus, filteredLocations, filteredMinStocks, filteredUnits);
            listView.setAdapter(listAdapter);
            listAdapter.notifyDataSetChanged();
        }

    }

    public void filterList(String query) {
        
        clearFilteredArrays();
        
        if (query == null || query.trim().isEmpty()) {
            // Se a busca está vazia, mostrar todos os itens
            copyToFilteredLists();
        } else {
            // Filtrar itens baseado na busca
            String searchQuery = query.toLowerCase().trim();
            
            for (int i = 0; i < names.size(); i++) {
                String name = names.get(i) != null ? names.get(i).toLowerCase() : "";
                String category = categories.get(i) != null ? categories.get(i).toLowerCase() : "";
                String sku = skus.get(i) != null ? skus.get(i).toLowerCase() : "";
                String barcode = barcodes.get(i) != null ? barcodes.get(i).toLowerCase() : "";
                String location = locations.get(i) != null ? locations.get(i).toLowerCase() : "";
                String description = descriptions.get(i) != null ? descriptions.get(i).toLowerCase() : "";
                
                // Verificar se algum dos campos contém o texto da busca
                if (name.contains(searchQuery) || 
                    category.contains(searchQuery) || 
                    sku.contains(searchQuery) || 
                    barcode.contains(searchQuery) || 
                    location.contains(searchQuery) ||
                    description.contains(searchQuery)) {
                    
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
        
        listAdapter = new CustomListView(this, filteredNames, filteredAmounts, filteredValues, filteredPhotos, filteredCategories, filteredSkus, filteredLocations, filteredMinStocks, filteredUnits);
        listView.setAdapter(listAdapter);
        listAdapter.notifyDataSetChanged();
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

    public void getListValues() {

        clearArrays();

        // Verificar se o banco de dados está disponível
        if (stock == null || !stock.isOpen()) {
            Log.e("MainActivity", "Database is not available in getListValues");
            Toast.makeText(this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
            return;
        }

        Cursor cursor = null;
        try {
            cursor = stock.rawQuery("SELECT name, description, amount, value, photo, category, sku, barcode, supplier, location, min_stock, unit FROM Estoque", null);

            if (cursor != null && cursor.moveToFirst()) {

                do {

                    String columnName = cursor.getString(0);
                    String columnDescription = cursor.getString(1);
                    String columnAmount = cursor.getString(2);
                    String columnValue = cursor.getString(3);
                    String columnPhoto = cursor.getString(4);
                    String columnCategory = cursor.getString(5);
                    String columnSku = cursor.getString(6);
                    String columnBarcode = cursor.getString(7);
                    String columnSupplier = cursor.getString(8);
                    String columnLocation = cursor.getString(9);
                    String columnMinStock = cursor.getString(10);
                    String columnUnit = cursor.getString(11);

                    names.add(columnName);
                    descriptions.add(columnDescription);
                    amounts.add(columnAmount);
                    values.add(columnValue);
                    photos.add(columnPhoto);
                    categories.add(columnCategory);
                    skus.add(columnSku);
                    barcodes.add(columnBarcode);
                    suppliers.add(columnSupplier);
                    locations.add(columnLocation);
                    minStocks.add(columnMinStock);
                    units.add(columnUnit);

                } while (cursor.moveToNext());

            }
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
                .setTitle("Atenção")
                .setMessage("Tem certeza que deseja remover o item '" + productName + "'?")
                .setIcon(R.drawable.delete_icon)
                .setPositiveButton(android.R.string.yes, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int whichButton) {
                        try {
                            // Verificar se o banco de dados está disponível
                            if (stock == null || !stock.isOpen()) {
                                Log.e("MainActivity", "Database is not available in deleteProduct");
                                Toast.makeText(MainActivity.this, "Erro: Banco de dados não disponível", Toast.LENGTH_SHORT).show();
                                return;
                            }
                            
                            // Usar query parametrizada para prevenir SQL injection
                            int rowsDeleted = stock.delete("Estoque", "name=?", new String[]{finalProductName});
                            
                            if (rowsDeleted > 0) {
                                updateList();
                                Toast.makeText(MainActivity.this, "Produto removido com sucesso!", Toast.LENGTH_LONG).show();
                                
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
                .setNegativeButton(android.R.string.no, null).show();

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

        Cursor cursor = null;
        try {
            // Usar query parametrizada para prevenir SQL injection
            cursor = stock.rawQuery("SELECT * FROM Estoque WHERE name=?", new String[]{productName});
            return cursor != null && cursor.getCount() > 0;
        } catch (Exception e) {
            Log.e("MainActivity", "Error checking if product exists", e);
            return false;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
    }

    public void showAddActivity() {

        Intent intent = new Intent(this, AddActivity.class);
        startActivity(intent);

    }

    public void showEditActivity(String productName) {

        Intent intent = new Intent(this, EditActivity.class);
        intent.putExtra("productName", productName);
        startActivity(intent);

    }

    public void showReportsActivity() {

        Intent intent = new Intent(this, ReportsActivity.class);
        startActivity(intent);

    }

    public void showImportActivity() {

        Intent intent = new Intent(this, ImportActivity.class);
        startActivity(intent);

    }

    public void showHistoryActivity() {
        Intent intent = new Intent(this, HistoryActivity.class);
        startActivity(intent);
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
        alertDialog.setTitle("Seja Bem-Vindo!");
        alertDialog.setMessage("Esperamos que goste do aplicativo e que ele seja muito útil para você, em caso de dúvidas ou problemas por favor entre em contato conosco ;)");
        alertDialog.setButton(AlertDialog.BUTTON_NEUTRAL, "Ok",
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
        } else if (itemId == R.id.menu_go_pro) {
            showProActivity();
            return true;
        } else if (itemId == R.id.menu_about) {
            showAboutActivity();
            return true;
        } else if (itemId == R.id.menu_history) {
            showHistoryActivity();
            return true;
        } else if (itemId == R.id.menu_settings) {
            showSettingsActivity();
            return true;
        } else if (itemId == R.id.menu_exit) {
            exitApp();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    public void showAboutActivity() {
        Intent intent = new Intent(this, AboutActivity.class);
        startActivity(intent);
    }

    public void exitApp() {
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

    @Override
    protected void onStart() {
        super.onStart();
    }
    
    /**
     * Atualiza o card de premium de acordo com o status do usuário
     */
    public void updatePremiumCard() {
        if (premiumManager == null || premiumCard == null) {
            return;
        }
        
        boolean isPro = premiumManager.isPro();
        boolean isTempActive = premiumManager.isTempPremiumActive();
        boolean isCardDismissed = prefs.getBoolean("premiumCardDismissed", false);
        
        if (isPro) {
            // Usuário é PRO permanente, esconder o card
            premiumCard.setVisibility(View.GONE);
        } else if (isCardDismissed) {
            // Usuário fechou o card, esconder
            premiumCard.setVisibility(View.GONE);
        } else if (isTempActive) {
            // Modo temporário ativo, mostrar tempo restante
            premiumCard.setVisibility(View.VISIBLE);
            premiumCardTitle.setText(R.string.premium_card_title);
            premiumCardMessage.setText(getString(R.string.premium_card_time_remaining, 
                                                premiumManager.getFormattedRemainingTime()));
            btnPremiumCardAction.setText(R.string.premium_card_upgrade);
            btnPremiumCardAction.setOnClickListener(v -> showProActivity());
        } else {
            // Usuário não tem premium, aplicar sistema de chance (1 em 3)
            boolean shouldShow = shouldShowPremiumCard();
            
            if (shouldShow) {
                premiumCard.setVisibility(View.VISIBLE);
                premiumCardTitle.setText(R.string.premium_card_watch_ad_title);
                premiumCardMessage.setText(R.string.premium_card_watch_ad_message);
                btnPremiumCardAction.setText(R.string.premium_card_watch_ad_button);
                btnPremiumCardAction.setOnClickListener(v -> onPremiumCardActionClicked());
            } else {
                premiumCard.setVisibility(View.GONE);
            }
        }
    }
    
    /**
     * Sistema de chance: card aparece 1 em 3 vezes
     * @return true se o card deve ser exibido
     */
    private boolean shouldShowPremiumCard() {
        // Gera um número aleatório entre 0 e 2 (0, 1, 2)
        // Se for 0, mostra o card (chance de 1 em 3)
        java.util.Random random = new java.util.Random();
        int chance = random.nextInt(3);
        return chance == 0;
    }
    
    /**
     * Handler para o clique no botão de fechar o card
     */
    private void onClosePremiumCardClicked() {
        // Salvar que o card foi fechado
        SharedPreferences.Editor editor = prefs.edit();
        editor.putBoolean("premiumCardDismissed", true);
        editor.apply();
        
        // Esconder o card
        premiumCard.setVisibility(View.GONE);
        
        Toast.makeText(this, "Você pode ativar o modo sem anúncios pelo menu 'Versão Profissional'", Toast.LENGTH_SHORT).show();
    }
    
    /**
     * Handler para o clique no botão do card de premium
     */
    private void onPremiumCardActionClicked() {
        if (premiumManager.isTempPremiumActive()) {
            // Já está em modo temporário, levar para tela PRO
            showProActivity();
        } else {
            // Oferecer assistir rewarded video
            showRewardedVideoOffer();
        }
    }
    
    /**
     * Mostra oferta para assistir rewarded video
     */
    private void showRewardedVideoOffer() {
        new AlertDialog.Builder(this)
            .setTitle("🎬 1 Hora Sem Anúncios")
            .setMessage("Assista um vídeo curto e ganhe 1 HORA completa sem anúncios!\n\nDeseja continuar?")
            .setPositiveButton("Assistir", (dialog, which) -> {
                // Usar o AdManager para mostrar rewarded video
                if (adManager != null) {
                    adManager.showRewardedVideoForPremium(this);
                }
            })
            .setNegativeButton("Agora Não", null)
            .show();
    }
    
    /**
     * Inicia o timer para atualizar o card de premium
     */
    private void startPremiumUpdateTimer() {
        stopPremiumUpdateTimer();
        
        premiumUpdateHandler = new Handler();
        premiumUpdateRunnable = new Runnable() {
            @Override
            public void run() {
                updatePremiumCard();
                if (premiumUpdateHandler != null) {
                    premiumUpdateHandler.postDelayed(this, 60000); // Atualizar a cada minuto
                }
            }
        };
        
        premiumUpdateHandler.postDelayed(premiumUpdateRunnable, 60000);
    }
    
    /**
     * Para o timer de atualização do card de premium
     */
    private void stopPremiumUpdateTimer() {
        if (premiumUpdateHandler != null && premiumUpdateRunnable != null) {
            premiumUpdateHandler.removeCallbacks(premiumUpdateRunnable);
        }
    }
    
    /**
     * Mostra a tela PRO
     */
    private void showProActivity() {
        Intent intent = new Intent(this, ProActivity.class);
        startActivity(intent);
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
        final String[] options = {"Ajustar Quantidade", "Definir Categoria", "Definir Fornecedor"};
        
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
     * Ajusta quantidade em massa
     */
    private void showBulkAdjustQuantityDialog(final java.util.List<String> selectedProducts) {
        android.widget.EditText input = new android.widget.EditText(this);
        input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_FLAG_SIGNED | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL);
        input.setHint("Digite a quantidade (+ ou -)");
        
        new AlertDialog.Builder(this)
            .setTitle("Ajustar Quantidade")
            .setMessage("Digite a quantidade a adicionar (+10) ou remover (-5):")
            .setView(input)
            .setPositiveButton("OK", (dialog, which) -> {
                String value = input.getText().toString();
                if (!value.isEmpty()) {
                    double adjustment = CurrencyHelper.parseCurrency(value, Double.NaN);
                    if (Double.isNaN(adjustment)) {
                        Toast.makeText(this, "Valor inválido", Toast.LENGTH_SHORT).show();
                    } else {
                        performBulkQuantityAdjustment(selectedProducts, adjustment);
                    }
                }
            })
            .setNegativeButton("Cancelar", null)
            .show();
    }
    
    /**
     * Define categoria em massa
     */
    private void showBulkSetCategoryDialog(final java.util.List<String> selectedProducts) {
        android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("Digite a categoria");
        
        new AlertDialog.Builder(this)
            .setTitle("Definir Categoria")
            .setMessage("Digite a nova categoria para os produtos selecionados:")
            .setView(input)
            .setPositiveButton("OK", (dialog, which) -> {
                String category = input.getText().toString();
                if (!category.isEmpty()) {
                    performBulkCategoryUpdate(selectedProducts, category);
                }
            })
            .setNegativeButton("Cancelar", null)
            .show();
    }
    
    /**
     * Define fornecedor em massa
     */
    private void showBulkSetSupplierDialog(final java.util.List<String> selectedProducts) {
        android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("Digite o fornecedor");
        
        new AlertDialog.Builder(this)
            .setTitle("Definir Fornecedor")
            .setMessage("Digite o novo fornecedor para os produtos selecionados:")
            .setView(input)
            .setPositiveButton("OK", (dialog, which) -> {
                String supplier = input.getText().toString();
                if (!supplier.isEmpty()) {
                    performBulkSupplierUpdate(selectedProducts, supplier);
                }
            })
            .setNegativeButton("Cancelar", null)
            .show();
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
        for (String productName : products) {
            Cursor cursor = null;
            try {
                cursor = stock.rawQuery("SELECT amount FROM Estoque WHERE name=?", new String[]{productName});
            if (cursor.moveToFirst()) {
                double currentAmount = CurrencyHelper.parseCurrency(cursor.getString(0), 0);
                double newAmount = Math.max(0, currentAmount + adjustment); // Não permitir quantidades negativas
                
                ContentValues values = new ContentValues();
                values.put("amount", CurrencyHelper.quantityForStorage(newAmount));
                stock.update("Estoque", values, "name=?", new String[]{productName});
                updated++;
            }
            } catch (Exception e) {
                Log.e("MainActivity", "Error adjusting quantity for product: " + productName, e);
            } finally {
                if (cursor != null) {
                    try {
                        cursor.close();
                    } catch (Exception e) {
                        Log.e("MainActivity", "Error closing cursor", e);
                    }
                }
            }
        }
        
        updateList();
        Toast.makeText(this, getString(R.string.bulk_edit_success, updated), Toast.LENGTH_SHORT).show();
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
        for (String productName : products) {
            try {
                ContentValues values = new ContentValues();
                values.put("category", category);
                int rows = stock.update("Estoque", values, "name=?", new String[]{productName});
                if (rows > 0) updated++;
            } catch (Exception e) {
                Log.e("MainActivity", "Error updating category for product: " + productName, e);
            }
        }
        
        updateList();
        Toast.makeText(this, getString(R.string.bulk_edit_success, updated), Toast.LENGTH_SHORT).show();
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
        for (String productName : products) {
            try {
                ContentValues values = new ContentValues();
                values.put("supplier", supplier);
                int rows = stock.update("Estoque", values, "name=?", new String[]{productName});
                if (rows > 0) updated++;
            } catch (Exception e) {
                Log.e("MainActivity", "Error updating supplier for product: " + productName, e);
            }
        }
        
        updateList();
        Toast.makeText(this, getString(R.string.bulk_edit_success, updated), Toast.LENGTH_SHORT).show();
    }

}
