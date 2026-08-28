package br.com.gameloop.estoquesimples.billing;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryPurchasesParams;

import java.util.List;

import br.com.gameloop.estoquesimples.Constants;
import br.com.gameloop.estoquesimples.PremiumManager;

/**
 * Reconhece a compra única antiga ({@code pro}), sem oferecer novas compras.
 *
 * A oferta comercial desse produto saiu do aplicativo. Quem já comprou
 * continua com os benefícios daquela versão — recursos premium e sem
 * anúncios — e precisa restaurar ou ter a compra consultada na Play Store.
 * Sincronização em nuvem nunca entra neste direito.
 */
public final class LegacyProBilling implements PurchasesUpdatedListener {

    private static final String TAG = "LegacyProBilling";

    public enum Result {
        RECOGNIZED,
        NOT_FOUND,
        PENDING,
        STORE_NOT_READY,
        ERROR
    }

    public interface ConnectionListener {
        void onReady();

        void onError(String message);
    }

    public interface ResultCallback {
        void onResult(@NonNull Result result, @Nullable String message);
    }

    private final Context appContext;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final PremiumManager premiumManager;

    private BillingClient billingClient;
    private ConnectionListener connectionListener;
    private ResultCallback purchaseUpdateCallback;

    public LegacyProBilling(Context context) {
        this.appContext = context.getApplicationContext();
        this.premiumManager = PremiumManager.getInstance(appContext);
    }

    /**
     * Consulta pontual: conecta, pergunta à loja, aplica o direito e desconecta.
     *
     * Evita um segundo {@link BillingClient} vivo ao mesmo tempo que o da
     * assinatura, o que a Play Billing desencoraja.
     */
    public static void runQuery(@NonNull Context context, boolean userInitiated,
                                @NonNull ResultCallback callback) {
        LegacyProBilling billing = new LegacyProBilling(context);
        Handler main = new Handler(Looper.getMainLooper());
        java.util.concurrent.atomic.AtomicBoolean finished =
                new java.util.concurrent.atomic.AtomicBoolean(false);

        Runnable timeout = () -> {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            billing.endConnection();
            callback.onResult(Result.STORE_NOT_READY,
                    "Não foi possível conectar à Play Store.");
        };
        main.postDelayed(timeout, 12_000L);

        billing.start(new ConnectionListener() {
            @Override
            public void onReady() {
                billing.queryExisting(userInitiated, (result, message) -> {
                    if (!finished.compareAndSet(false, true)) {
                        return;
                    }
                    main.removeCallbacks(timeout);
                    billing.endConnection();
                    callback.onResult(result, message);
                });
            }

            @Override
            public void onError(String message) {
                if (!finished.compareAndSet(false, true)) {
                    return;
                }
                main.removeCallbacks(timeout);
                billing.endConnection();
                callback.onResult(Result.ERROR, message);
            }
        });
    }

    public void setPurchaseUpdateCallback(@Nullable ResultCallback callback) {
        this.purchaseUpdateCallback = callback;
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
                        main.post(connectionListener::onReady);
                    }
                    return;
                }
                Log.e(TAG, "conexão com a loja falhou: "
                        + billingResult.getResponseCode() + " "
                        + billingResult.getDebugMessage());
                if (connectionListener != null) {
                    main.post(() -> connectionListener.onError(
                            "Não foi possível conectar à Play Store."));
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

    /**
     * Consulta compras INAPP já feitas e aplica o direito local se encontrar {@code pro}.
     *
     * Não inicia fluxo de compra. {@code userInitiated} só altera a mensagem
     * quando nada é encontrado — a consulta silenciosa no arranque não deve
     * acusar “nenhuma compra” para quem nunca foi PRO.
     */
    public void queryExisting(boolean userInitiated, @NonNull ResultCallback callback) {
        if (!isReady()) {
            main.post(() -> callback.onResult(Result.STORE_NOT_READY,
                    "Aguarde a conexão com a loja."));
            return;
        }

        billingClient.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build(),
                (billingResult, purchases) -> {
                    if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        main.post(() -> callback.onResult(Result.ERROR,
                                "Erro ao verificar compras. Tente novamente mais tarde."));
                        return;
                    }
                    applyPurchases(purchases, userInitiated, callback);
                });
    }

    private void applyPurchases(@Nullable List<Purchase> purchases,
                                boolean userInitiated,
                                @NonNull ResultCallback callback) {
        if (purchases == null || purchases.isEmpty()) {
            main.post(() -> callback.onResult(Result.NOT_FOUND,
                    userInitiated
                            ? "Nenhuma compra da antiga Versão PRO encontrada nesta conta Google."
                            : null));
            return;
        }

        boolean foundPending = false;
        for (Purchase purchase : purchases) {
            if (!purchase.getProducts().contains(Constants.PRODUCT_ID_PRO)) {
                continue;
            }
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                foundPending = true;
                continue;
            }
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                if (!purchase.isAcknowledged()) {
                    acknowledge(purchase);
                }
                premiumManager.setPro(true);
                main.post(() -> callback.onResult(Result.RECOGNIZED, null));
                return;
            }
        }

        if (foundPending) {
            main.post(() -> callback.onResult(Result.PENDING,
                    "Sua compra antiga ainda está sendo processada. "
                            + "O acesso PRO entra quando o Google confirmar o pagamento."));
            return;
        }

        main.post(() -> callback.onResult(Result.NOT_FOUND,
                userInitiated
                        ? "Nenhuma compra da antiga Versão PRO encontrada nesta conta Google."
                        : null));
    }

    private void acknowledge(Purchase purchase) {
        AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.getPurchaseToken())
                .build();
        billingClient.acknowledgePurchase(params, billingResult -> {
            if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                Log.d(TAG, "compra antiga reconhecida (acknowledge)");
            }
        });
    }

    public void endConnection() {
        connectionListener = null;
        purchaseUpdateCallback = null;
        if (billingClient != null) {
            try {
                billingClient.endConnection();
            } catch (Exception e) {
                Log.w(TAG, "falha ao encerrar billing da compra antiga", e);
            }
            billingClient = null;
        }
    }

    /**
     * Compra pendente que o Google confirmar depois — não é uma nova oferta.
     */
    @Override
    public void onPurchasesUpdated(@NonNull BillingResult billingResult,
                                   @Nullable List<Purchase> purchases) {
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK
                || purchases == null) {
            return;
        }
        applyPurchases(purchases, false, (result, message) -> {
            if (purchaseUpdateCallback != null) {
                purchaseUpdateCallback.onResult(result, message);
            }
        });
    }
}
