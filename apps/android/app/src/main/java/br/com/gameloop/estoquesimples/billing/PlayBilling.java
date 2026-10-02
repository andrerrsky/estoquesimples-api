package br.com.gameloop.estoquesimples.billing;

import android.app.Activity;
import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

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

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import br.com.gameloop.estoquesimples.Constants;

/**
 * Invólucro do BillingClient para a assinatura mensal.
 *
 * A compra única antiga ({@code pro}) não é vendida por aqui: só a assinatura
 * ({@code assinatura} / {@code plano-basico}). Quem já comprou {@code pro}
 * é reconhecido em {@code LegacyProBilling}. O app <b>não</b> faz acknowledge
 * da assinatura: quem confirma a compra é o servidor depois de validar na
 * Play Developer API.
 */
public final class PlayBilling implements PurchasesUpdatedListener {

    private static final String TAG = "PlayBilling";
    private static final long TIMEOUT_MS = 20_000L;

    public interface ConnectionListener {
        void onReady();

        void onError(String message);
    }

    public interface OfferCallback {
        void onOffer(@Nullable Offer offer, @Nullable String error);
    }

    public interface PurchasesCallback {
        void onPurchases(@NonNull List<Purchase> purchases, @Nullable String error);
    }

    public interface PurchaseUpdateListener {
        void onPurchasesUpdated(@NonNull BillingResult result, @Nullable List<Purchase> purchases);
    }

    /** Oferta do base plan {@code plano-basico} pronta para o fluxo de compra. */
    public static final class Offer {
        public final ProductDetails productDetails;
        public final String offerToken;
        public final String formattedPrice;
        public final String billingPeriod;

        Offer(ProductDetails productDetails, String offerToken,
              String formattedPrice, String billingPeriod) {
            this.productDetails = productDetails;
            this.offerToken = offerToken;
            this.formattedPrice = formattedPrice;
            this.billingPeriod = billingPeriod;
        }
    }

    private final Context appContext;
    private BillingClient billingClient;
    private ConnectionListener connectionListener;
    private PurchaseUpdateListener purchaseUpdateListener;

    public PlayBilling(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void setPurchaseUpdateListener(@Nullable PurchaseUpdateListener listener) {
        this.purchaseUpdateListener = listener;
    }

    public void start(@Nullable ConnectionListener listener) {
        this.connectionListener = listener;

        PendingPurchasesParams pendingPurchasesParams = PendingPurchasesParams.newBuilder()
                .enableOneTimeProducts()
                .build();

        billingClient = BillingClient.newBuilder(appContext)
                .setListener(this)
                .enablePendingPurchases(pendingPurchasesParams)
                .enableAutoServiceReconnection()
                .build();

        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult billingResult) {
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    if (connectionListener != null) {
                        connectionListener.onReady();
                    }
                    return;
                }

                Log.e(TAG, "conexão com a loja falhou: code="
                        + billingResult.getResponseCode()
                        + " " + billingResult.getDebugMessage());

                // Com reconexão automática, SERVICE_UNAVAILABLE / NETWORK_ERROR
                // aparecem no primeiro handshake e a loja sobe logo em seguida.
                // Tratar isso como erro definitivo faz a tela acusar falha
                // enquanto o spinner ainda carrega o estado real.
                if (connectionListener != null && isPermanentSetupFailure(
                        billingResult.getResponseCode())) {
                    connectionListener.onError("Não foi possível conectar à Play Store.");
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                Log.d(TAG, "serviço de billing desconectado; reconexão automática ativa");
            }
        });
    }

    public boolean isReady() {
        return billingClient != null && billingClient.isReady();
    }

    public void queryOffer(@NonNull OfferCallback callback) {
        if (!isReady()) {
            callback.onOffer(null, "Loja ainda não está pronta.");
            return;
        }

        List<QueryProductDetailsParams.Product> productList = new ArrayList<>();
        productList.add(
                QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(Constants.SUBSCRIPTION_PRODUCT_ID)
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build());

        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                .setProductList(productList)
                .build();

        billingClient.queryProductDetailsAsync(params, (billingResult, queryResult) -> {
            if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                callback.onOffer(null, "Não foi possível carregar o preço da assinatura.");
                return;
            }

            List<ProductDetails> detailsList = queryResult.getProductDetailsList();
            if (detailsList == null || detailsList.isEmpty()) {
                callback.onOffer(null, "Assinatura indisponível nesta região ou conta Google.");
                return;
            }

            ProductDetails details = detailsList.get(0);
            Offer offer = findBasePlanOffer(details);
            if (offer == null) {
                callback.onOffer(null, "Plano indisponível nesta região ou conta Google.");
                return;
            }
            callback.onOffer(offer, null);
        });
    }

    /**
     * Inicia o fluxo de assinatura.
     *
     * {@code obfuscatedAccountId} é o SHA-256 hex do workspaceId (máx. 64 chars),
     * antifraude recomendado pelo Google e útil no suporte.
     */
    public BillingResult launchSubscribe(@NonNull Activity activity, @NonNull Offer offer,
                                         @Nullable String obfuscatedAccountId) {
        BillingFlowParams.ProductDetailsParams.Builder productParams =
                BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(offer.productDetails)
                        .setOfferToken(offer.offerToken);

        BillingFlowParams.Builder flowBuilder = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(productParams.build()));

        if (obfuscatedAccountId != null && !obfuscatedAccountId.isEmpty()) {
            flowBuilder.setObfuscatedAccountId(obfuscatedAccountId);
        }

        return billingClient.launchBillingFlow(activity, flowBuilder.build());
    }

    public void queryPurchases(@NonNull PurchasesCallback callback) {
        if (!isReady()) {
            callback.onPurchases(Collections.emptyList(), "Loja ainda não está pronta.");
            return;
        }

        billingClient.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build(),
                (billingResult, purchases) -> {
                    if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        callback.onPurchases(Collections.emptyList(),
                                "Não foi possível consultar compras existentes.");
                        return;
                    }
                    callback.onPurchases(purchases != null ? purchases : Collections.emptyList(),
                            null);
                });
    }

    /**
     * Consulta compras de assinatura de forma bloqueante (para o Worker).
     *
     * Abre uma conexão própria, consulta e encerra. Não reutiliza a instância
     * da tela: o WorkManager pode rodar sem Activity viva.
     */
    @NonNull
    public static List<Purchase> queryPurchasesBlocking(@NonNull Context context)
            throws InterruptedException {
        CountDownLatch connected = new CountDownLatch(1);
        CountDownLatch queried = new CountDownLatch(1);
        AtomicReference<List<Purchase>> result = new AtomicReference<>(Collections.emptyList());
        AtomicReference<BillingClient> clientRef = new AtomicReference<>();

        PendingPurchasesParams pendingPurchasesParams = PendingPurchasesParams.newBuilder()
                .enableOneTimeProducts()
                .build();

        BillingClient client = BillingClient.newBuilder(context.getApplicationContext())
                .setListener((billingResult, purchases) -> {
                    // Sem fluxo de compra no worker; listener obrigatório.
                })
                .enablePendingPurchases(pendingPurchasesParams)
                .enableAutoServiceReconnection()
                .build();
        clientRef.set(client);

        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult billingResult) {
                connected.countDown();
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Sem ação: o await abaixo trata timeout.
            }
        });

        if (!connected.await(TIMEOUT_MS, TimeUnit.MILLISECONDS) || !client.isReady()) {
            try {
                client.endConnection();
            } catch (Exception ignored) {
            }
            return Collections.emptyList();
        }

        client.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build(),
                (billingResult, purchases) -> {
                    if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK
                            && purchases != null) {
                        result.set(purchases);
                    }
                    queried.countDown();
                });

        queried.await(TIMEOUT_MS, TimeUnit.MILLISECONDS);
        try {
            client.endConnection();
        } catch (Exception ignored) {
        }
        return result.get();
    }

    /**
     * Falha de setup que não se resolve sozinha com a reconexão automática.
     *
     * Sem Play Store, conta Google ou configuração do Billing, insistir só
     * atrasaria o aviso. Os demais códigos costumam ser o primeiro handshake.
     */
    private static boolean isPermanentSetupFailure(int code) {
        return code == BillingClient.BillingResponseCode.BILLING_UNAVAILABLE
                || code == BillingClient.BillingResponseCode.DEVELOPER_ERROR
                || code == BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED;
    }

    /** Primeira compra PURCHASED do produto de assinatura, se houver. */
    @Nullable
    public static Purchase findPurchasedSubscription(@NonNull List<Purchase> purchases) {
        for (Purchase purchase : purchases) {
            if (purchase.getProducts().contains(Constants.SUBSCRIPTION_PRODUCT_ID)
                    && purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                return purchase;
            }
        }
        return null;
    }

    /** Hash SHA-256 hex do workspaceId, truncado em 64 caracteres. */
    @NonNull
    public static String obfuscatedAccountId(@Nullable String workspaceId) {
        if (workspaceId == null || workspaceId.isEmpty()) {
            return "";
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(workspaceId.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                hex.append(String.format(java.util.Locale.US, "%02x", b));
            }
            String value = hex.toString();
            return value.length() > 64 ? value.substring(0, 64) : value;
        } catch (NoSuchAlgorithmException e) {
            return workspaceId.length() > 64 ? workspaceId.substring(0, 64) : workspaceId;
        }
    }

    public void endConnection() {
        connectionListener = null;
        purchaseUpdateListener = null;
        if (billingClient != null) {
            try {
                billingClient.endConnection();
            } catch (Exception e) {
                Log.w(TAG, "falha ao encerrar billing", e);
            }
            billingClient = null;
        }
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult billingResult,
                                   @Nullable List<Purchase> purchases) {
        if (purchaseUpdateListener != null) {
            purchaseUpdateListener.onPurchasesUpdated(billingResult, purchases);
        }
    }

    @Nullable
    private static Offer findBasePlanOffer(@NonNull ProductDetails details) {
        List<ProductDetails.SubscriptionOfferDetails> offers =
                details.getSubscriptionOfferDetails();
        if (offers == null) {
            return null;
        }
        for (ProductDetails.SubscriptionOfferDetails offerDetails : offers) {
            if (!Constants.SUBSCRIPTION_BASE_PLAN_ID.equals(offerDetails.getBasePlanId())) {
                continue;
            }
            // Preferir a oferta sem offerId (preço base), se houver várias.
            String offerToken = offerDetails.getOfferToken();
            if (offerToken == null || offerToken.isEmpty()) {
                continue;
            }
            String price = "";
            String period = "";
            List<ProductDetails.PricingPhase> phases =
                    offerDetails.getPricingPhases().getPricingPhaseList();
            if (phases != null && !phases.isEmpty()) {
                ProductDetails.PricingPhase phase = phases.get(0);
                price = phase.getFormattedPrice();
                period = phase.getBillingPeriod();
            }
            return new Offer(details, offerToken, price, period);
        }
        return null;
    }
}
