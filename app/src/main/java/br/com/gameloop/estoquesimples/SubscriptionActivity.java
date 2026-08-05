package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.Purchase;

import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.billing.LinkPurchaseWorker;
import br.com.gameloop.estoquesimples.billing.PendingPurchase;
import br.com.gameloop.estoquesimples.billing.PlayBilling;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.EntitlementManager;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.SubscriptionClient;
import br.com.gameloop.estoquesimples.sync.SyncBootstrap;

/**
 * Compra e estado da assinatura que libera a sincronização em nuvem.
 *
 * Só o proprietário compra ({@code assinatura.gerenciar}); os demais membros
 * apenas veem o estado. O direito local só muda a partir do entitlement
 * devolvido pela API — nunca a partir do resultado cru do Billing.
 */
public class SubscriptionActivity extends BaseActivity {

    private static final String PLAY_MANAGE_URL =
            "https://play.google.com/store/account/subscriptions"
                    + "?sku=" + Constants.SUBSCRIPTION_PRODUCT_ID
                    + "&package=br.com.gameloop.estoquesimples";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private SessionManager session;
    private EntitlementManager entitlements;
    private PendingPurchase pending;
    private PlayBilling playBilling;
    private PlayBilling.Offer currentOffer;

    private TextView stateView;
    private TextView priceView;
    private TextView noticeView;
    private TextView messageView;
    private ProgressBar progress;
    private Button subscribeButton;
    private Button restoreButton;
    private Button manageButton;
    private Button goAccountButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_subscription);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Assinatura da nuvem");
        }

        session = SessionManager.get(this);
        entitlements = new EntitlementManager(this);
        pending = new PendingPurchase(this);

        bindViews();
        renderFromLocal();

        if (!session.isSignedIn() || session.workspaceId() == null) {
            showGateToAccount();
            return;
        }

        playBilling = new PlayBilling(this);
        playBilling.setPurchaseUpdateListener(this::onPurchasesUpdated);
        playBilling.start(new PlayBilling.ConnectionListener() {
            @Override
            public void onReady() {
                main.post(() -> {
                    loadOffer();
                    maybeResumePending();
                });
            }

            @Override
            public void onError(String message) {
                main.post(() -> showMessage(message));
            }
        });

        refreshEntitlementInBackground();
    }

    private void bindViews() {
        stateView = findViewById(R.id.subscriptionState);
        priceView = findViewById(R.id.subscriptionPrice);
        noticeView = findViewById(R.id.subscriptionNotice);
        messageView = findViewById(R.id.messageView);
        progress = findViewById(R.id.progress);
        subscribeButton = findViewById(R.id.subscribeButton);
        restoreButton = findViewById(R.id.restoreButton);
        manageButton = findViewById(R.id.manageButton);
        goAccountButton = findViewById(R.id.goAccountButton);

        subscribeButton.setOnClickListener(v -> initiateSubscribe());
        restoreButton.setOnClickListener(v -> restorePurchase());
        manageButton.setOnClickListener(v ->
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_MANAGE_URL))));
        goAccountButton.setOnClickListener(v ->
                startActivity(new Intent(this, AccountActivity.class)));
    }

    private void showGateToAccount() {
        stateView.setText("Para assinar a nuvem, entre na sua conta e escolha uma empresa. "
                + "O comprovante precisa de uma empresa para onde ser vinculado.");
        goAccountButton.setVisibility(View.VISIBLE);
        subscribeButton.setVisibility(View.GONE);
        restoreButton.setVisibility(View.GONE);
        manageButton.setVisibility(View.GONE);
    }

    private void renderFromLocal() {
        stateView.setText(entitlements.stateLegivel());
        updatePendingNotice();
        updateActionVisibility();
    }

    private void updatePendingNotice() {
        if (pending.isPermanentError() && pending.lastError() != null) {
            noticeView.setVisibility(View.VISIBLE);
            noticeView.setText(pending.lastError());
        } else if (pending.hasToken()) {
            noticeView.setVisibility(View.VISIBLE);
            noticeView.setText("Confirmando a compra junto ao servidor…");
        } else {
            noticeView.setVisibility(View.GONE);
        }
    }

    private void updateActionVisibility() {
        boolean signedInWithWorkspace =
                session.isSignedIn() && session.workspaceId() != null;
        boolean proprietario = "proprietario".equals(session.role());
        boolean ativa = entitlements.canSync();

        if (!signedInWithWorkspace) {
            return;
        }

        goAccountButton.setVisibility(View.GONE);
        manageButton.setVisibility(View.VISIBLE);

        if (!proprietario) {
            subscribeButton.setVisibility(View.GONE);
            restoreButton.setVisibility(View.GONE);
            noticeView.setVisibility(View.VISIBLE);
            if (!pending.hasToken() && !pending.isPermanentError()) {
                noticeView.setText("Peça ao proprietário da empresa para assinar.");
            }
            return;
        }

        subscribeButton.setVisibility(ativa ? View.GONE : View.VISIBLE);
        restoreButton.setVisibility(View.VISIBLE);
    }

    private void loadOffer() {
        if (playBilling == null) {
            return;
        }
        playBilling.queryOffer((offer, error) -> main.post(() -> {
            if (error != null) {
                showMessage(error);
                return;
            }
            currentOffer = offer;
            if (offer != null && offer.formattedPrice != null
                    && !offer.formattedPrice.isEmpty()) {
                priceView.setVisibility(View.VISIBLE);
                priceView.setText(offer.formattedPrice + " / mês");
                subscribeButton.setText("Assinar — " + offer.formattedPrice + "/mês");
            }
        }));
    }

    private void refreshEntitlementInBackground() {
        setBusy(true);
        executor.execute(() -> {
            try {
                entitlements.refresh();
                main.post(() -> {
                    setBusy(false);
                    renderFromLocal();
                    showMessage(null);
                });
            } catch (ApiException e) {
                main.post(() -> {
                    setBusy(false);
                    renderFromLocal();
                    if (!e.isTransient()) {
                        showMessage(e.userMessage());
                    }
                });
            }
        });
    }

    private void maybeResumePending() {
        if (pending.hasToken() && !pending.isPermanentError()) {
            linkToken(pending.token(), true);
        }
    }

    private void initiateSubscribe() {
        if (!"proprietario".equals(session.role())) {
            Toast.makeText(this, "Só o proprietário pode assinar.", Toast.LENGTH_LONG).show();
            return;
        }
        if (currentOffer == null || playBilling == null || !playBilling.isReady()) {
            Toast.makeText(this, "Aguarde, carregando o preço da assinatura…",
                    Toast.LENGTH_SHORT).show();
            loadOffer();
            return;
        }

        String obfuscated = PlayBilling.obfuscatedAccountId(session.workspaceId());
        BillingResult result = playBilling.launchSubscribe(this, currentOffer, obfuscated);
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            showMessage("Não foi possível abrir a compra: " + result.getDebugMessage());
        }
    }

    private void onPurchasesUpdated(@NonNull BillingResult billingResult,
                                    @Nullable List<Purchase> purchases) {
        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            main.post(() -> Toast.makeText(this, "Compra cancelada.", Toast.LENGTH_SHORT).show());
            return;
        }
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK
                || purchases == null) {
            main.post(() -> showMessage("Erro na compra: " + billingResult.getDebugMessage()));
            return;
        }

        for (Purchase purchase : purchases) {
            if (!purchase.getProducts().contains(Constants.SUBSCRIPTION_PRODUCT_ID)) {
                continue;
            }
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                // Token de compra pendente ainda não vale no servidor.
                // onPurchasesUpdated / restauração resolvem quando virar PURCHASED.
                main.post(() -> {
                    noticeView.setVisibility(View.VISIBLE);
                    noticeView.setText("Pagamento em processamento. Assim que o Google confirmar, "
                            + "a sincronização liga sozinha.");
                    Toast.makeText(this,
                            "Pagamento em processamento. A sincronização liga quando o Google confirmar.",
                            Toast.LENGTH_LONG).show();
                });
                return;
            }
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                pending.save(purchase.getPurchaseToken());
                main.post(this::updatePendingNotice);
                linkToken(purchase.getPurchaseToken(), true);
                return;
            }
        }
    }

    private void restorePurchase() {
        if (playBilling == null || !playBilling.isReady()) {
            Toast.makeText(this, "Aguarde a conexão com a Play Store.", Toast.LENGTH_SHORT).show();
            return;
        }
        setBusy(true);
        playBilling.queryPurchases((purchases, error) -> main.post(() -> {
            if (error != null) {
                setBusy(false);
                showMessage(error);
                return;
            }
            Purchase found = PlayBilling.findPurchasedSubscription(purchases);
            if (found == null) {
                setBusy(false);
                Toast.makeText(this, "Nenhuma assinatura encontrada nesta conta Google.",
                        Toast.LENGTH_LONG).show();
                return;
            }
            pending.save(found.getPurchaseToken());
            updatePendingNotice();
            linkToken(found.getPurchaseToken(), true);
        }));
    }

    private void linkToken(String purchaseToken, boolean enqueueOnTransient) {
        setBusy(true);
        executor.execute(() -> {
            try {
                JSONObject entitlement = new SubscriptionClient(this).link(purchaseToken);
                // Só confiar no entitlement da API — nunca no Billing sozinho.
                entitlements.apply(entitlement);
                pending.clear();
                SyncBootstrap.start(this);

                main.post(() -> {
                    setBusy(false);
                    showMessage(null);
                    renderFromLocal();
                    Toast.makeText(this, "Assinatura confirmada. A sincronização vai ligar.",
                            Toast.LENGTH_LONG).show();
                });
            } catch (ApiException e) {
                main.post(() -> handleLinkFailure(e, enqueueOnTransient));
            }
        });
    }

    private void handleLinkFailure(ApiException e, boolean enqueueOnTransient) {
        setBusy(false);
        String message = e.userMessage();
        if (isPermanentLinkError(e)) {
            pending.recordPermanentError(message);
            showMessage(message);
            updatePendingNotice();
            return;
        }
        pending.recordTransientError(message);
        updatePendingNotice();
        showMessage(message);
        if (enqueueOnTransient) {
            LinkPurchaseWorker.enqueue(this);
        }
    }

    private static boolean isPermanentLinkError(ApiException e) {
        String code = e.getCode();
        if (ApiException.TOKEN_EM_USO.equals(code)
                || ApiException.TOKEN_INVALIDO.equals(code)) {
            return true;
        }
        return e.getStatusCode() == 403 && !e.isTransient();
    }

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        subscribeButton.setEnabled(!busy);
        restoreButton.setEnabled(!busy);
    }

    private void showMessage(String mensagem) {
        if (mensagem == null || mensagem.isEmpty()) {
            messageView.setVisibility(View.GONE);
            return;
        }
        messageView.setText(mensagem);
        messageView.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onDestroy() {
        if (playBilling != null) {
            playBilling.endConnection();
        }
        executor.shutdown();
        super.onDestroy();
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
