package br.com.gameloop.estoquesimples;

import android.os.Bundle;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class ProActivity extends BaseActivity implements PurchasesUpdatedListener {

    private static final String TAG = "ProActivity";
    
    private BillingClient billingClient;
    private ProductDetails productDetails;
    private PremiumManager premiumManager;
    
    private Button btnBuyPro;
    private TextView txtRestorePurchase;
    private ProgressBar progressBar;
    private TextView txtStatus;
    private View layoutPremiumActive;
    private View layoutPremiumInactive;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_pro);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle(R.string.pro_title);
        }

        premiumManager = PremiumManager.getInstance(this);
        
        btnBuyPro = findViewById(R.id.btnBuyPro);
        txtRestorePurchase = findViewById(R.id.txtRestorePurchase);
        progressBar = findViewById(R.id.progressBar);
        txtStatus = findViewById(R.id.txtStatus);
        layoutPremiumActive = findViewById(R.id.layoutPremiumActive);
        layoutPremiumInactive = findViewById(R.id.layoutPremiumInactive);
        
        btnBuyPro.setOnClickListener(v -> initiatePurchase());
        txtRestorePurchase.setOnClickListener(v -> restorePurchases());
        
        setupBillingClient();
        
        // Atualizar UI com base no status premium
        updateUI();
    }

    private void setupBillingClient() {
        PendingPurchasesParams pendingPurchasesParams = PendingPurchasesParams.newBuilder()
            .enableOneTimeProducts()
            .build();
        
        billingClient = BillingClient.newBuilder(this)
            .setListener(this)
            .enablePendingPurchases(pendingPurchasesParams)
            .build();

        // Conectar ao Google Play Billing
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult billingResult) {
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    Log.d(TAG, "Billing client connected");
                    // Verificar compras existentes
                    queryPurchases();
                    // Carregar detalhes do produto
                    loadProductDetails();
                } else {
                    Log.e(TAG, "Billing client connection failed: " + billingResult.getDebugMessage());
                    showStatus("Erro ao conectar à loja. Tente novamente mais tarde.");
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                Log.d(TAG, "Billing client disconnected");
                // Tentar reconectar
                showStatus("Conexão perdida. Reconectando...");
            }
        });
    }

    private void loadProductDetails() {
        List<QueryProductDetailsParams.Product> productList = new ArrayList<>();
        productList.add(
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(Constants.PRODUCT_ID_PRO)
                .setProductType(BillingClient.ProductType.INAPP)
                .build()
        );
        
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(productList)
            .build();

        billingClient.queryProductDetailsAsync(params, (billingResult, queryProductDetailsResult) -> {
            if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                List<ProductDetails> detailsList = queryProductDetailsResult.getProductDetailsList();

                if (queryProductDetailsResult.getUnfetchedProductList() != null
                        && !queryProductDetailsResult.getUnfetchedProductList().isEmpty()) {
                    Log.w(TAG, "Some products could not be fetched: "
                            + queryProductDetailsResult.getUnfetchedProductList());
                }

                if (detailsList != null && !detailsList.isEmpty()) {
                    productDetails = detailsList.get(0);
                    Log.d(TAG, "Product details loaded: " + productDetails.getName());
                    runOnUiThread(() -> {
                        btnBuyPro.setEnabled(true);
                        showStatus("");
                    });
                } else {
                    Log.e(TAG, "Product not found in Play Store");
                    runOnUiThread(() -> showStatus(getString(R.string.pro_product_unavailable)));
                }
            } else {
                Log.e(TAG, "Failed to load product details: " + billingResult.getDebugMessage());
                runOnUiThread(() -> showStatus(getString(R.string.pro_product_load_error)));
            }
        });
    }

    private void queryPurchases() {
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build(),
            (billingResult, purchases) -> {
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    handlePurchases(purchases);
                }
            }
        );
    }

    private void initiatePurchase() {
        if (productDetails == null) {
            Toast.makeText(this, "Aguarde, carregando informações do produto...", Toast.LENGTH_SHORT).show();
            return;
        }

        List<BillingFlowParams.ProductDetailsParams> productDetailsParamsList = new ArrayList<>();
        productDetailsParamsList.add(
            BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(productDetails)
                .build()
        );
        
        BillingFlowParams billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(productDetailsParamsList)
            .build();

        BillingResult billingResult = billingClient.launchBillingFlow(this, billingFlowParams);
        
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            Toast.makeText(this, "Erro ao iniciar compra: " + billingResult.getDebugMessage(), 
                         Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult billingResult, @Nullable List<Purchase> purchases) {
        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK && purchases != null) {
            handlePurchases(purchases);
        } else if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            Toast.makeText(this, "Compra cancelada", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "Erro na compra: " + billingResult.getDebugMessage(), 
                         Toast.LENGTH_LONG).show();
        }
    }

    private void handlePurchases(List<Purchase> purchases) {
        for (Purchase purchase : purchases) {
            if (purchase.getProducts().contains(Constants.PRODUCT_ID_PRO)) {
                if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                    if (!purchase.isAcknowledged()) {
                        acknowledgePurchase(purchase);
                    }
                    
                    premiumManager.setPro(true);
                    
                    runOnUiThread(() -> {
                        showSuccessDialog();
                        updateUI();
                    });
                } else if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                    Log.d(TAG, "Purchase is pending");
                    runOnUiThread(() -> {
                        Toast.makeText(this,
                                getString(R.string.pro_purchase_pending),
                                Toast.LENGTH_LONG).show();
                    });
                }
            }
        }
    }

    private void acknowledgePurchase(Purchase purchase) {
        AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.getPurchaseToken())
            .build();

        billingClient.acknowledgePurchase(params, billingResult -> {
            if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                Log.d(TAG, "Purchase acknowledged");
            }
        });
    }

    private void restorePurchases() {
        if (billingClient == null || !billingClient.isReady()) {
            Toast.makeText(this, getString(R.string.pro_store_not_connected), Toast.LENGTH_SHORT).show();
            return;
        }

        progressBar.setVisibility(View.VISIBLE);
        showStatus(getString(R.string.pro_restoring));

        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build(),
            (billingResult, purchases) -> {
                runOnUiThread(() -> progressBar.setVisibility(View.GONE));

                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    boolean foundPro = false;
                    for (Purchase purchase : purchases) {
                        if (purchase.getProducts().contains(Constants.PRODUCT_ID_PRO)
                                && purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                            foundPro = true;
                            if (!purchase.isAcknowledged()) {
                                acknowledgePurchase(purchase);
                            }
                            premiumManager.setPro(true);
                            runOnUiThread(() -> {
                                showStatus("");
                                showSuccessDialog();
                                updateUI();
                            });
                            break;
                        }
                    }
                    if (!foundPro) {
                        runOnUiThread(() -> {
                            showStatus("");
                            Toast.makeText(ProActivity.this,
                                    getString(R.string.pro_no_purchase_found),
                                    Toast.LENGTH_LONG).show();
                        });
                    }
                } else {
                    runOnUiThread(() -> {
                        showStatus("");
                        Toast.makeText(ProActivity.this,
                                getString(R.string.pro_restore_error),
                                Toast.LENGTH_LONG).show();
                    });
                }
            }
        );
    }

    private void showSuccessDialog() {
        new AlertDialog.Builder(this)
            .setTitle("🎉 Parabéns!")
            .setMessage("Você agora é um usuário PRO!\n\nTodos os anúncios foram removidos e você tem acesso a recursos exclusivos.")
            .setPositiveButton("Ótimo!", (dialog, which) -> {
                // Atualizar MainActivity se estiver disponível
                if (MainActivity.instance != null) {
                    MainActivity.instance.updatePremiumCard();
                }
            })
            .setCancelable(false)
            .show();
    }

    private void updateUI() {
        boolean isPro = premiumManager.isPro();
        
        if (isPro) {
            // Usuário comprou a versão PRO
            layoutPremiumActive.setVisibility(View.VISIBLE);
            layoutPremiumInactive.setVisibility(View.GONE);
            TextView txtPremiumMessage = findViewById(R.id.txtPremiumMessage);
            txtPremiumMessage.setText("✨ Você é um usuário PRO!\n\nObrigado pelo seu apoio. Aproveite todos os recursos sem anúncios!");
        } else {
            // Usuário ainda não comprou
            layoutPremiumActive.setVisibility(View.GONE);
            layoutPremiumInactive.setVisibility(View.VISIBLE);
        }
    }

    private void showStatus(String message) {
        runOnUiThread(() -> {
            if (message.isEmpty()) {
                txtStatus.setVisibility(View.GONE);
            } else {
                txtStatus.setVisibility(View.VISIBLE);
                txtStatus.setText(message);
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateUI();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (billingClient != null) {
            billingClient.endConnection();
        }
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}

