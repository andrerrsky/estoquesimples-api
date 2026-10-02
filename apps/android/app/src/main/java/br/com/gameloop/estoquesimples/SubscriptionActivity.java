package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.analytics.Analytics;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.util.TypedValue;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.Purchase;

import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import br.com.gameloop.estoquesimples.billing.LegacyProBilling;
import br.com.gameloop.estoquesimples.billing.LinkPurchaseWorker;
import br.com.gameloop.estoquesimples.billing.PendingPurchase;
import br.com.gameloop.estoquesimples.billing.PlayBilling;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.EntitlementManager;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.SubscriptionClient;
import br.com.gameloop.estoquesimples.sync.SyncBootstrap;

/**
 * Única tela de contratação paga: a assinatura recorrente.
 *
 * A compra única antiga não é oferecida aqui. O rodapé só recupera direitos
 * já adquiridos. Só o proprietário compra ({@code assinatura.gerenciar});
 * o direito local só muda a partir do entitlement da API.
 */
public class SubscriptionActivity extends BaseActivity {

    private static final String PLAY_MANAGE_URL =
            "https://play.google.com/store/account/subscriptions"
                    + "?sku=" + Constants.SUBSCRIPTION_PRODUCT_ID
                    + "&package=br.com.gameloop.estoquesimples";

    /** Onde se gerencia a assinatura contratada pela versão web. */
    private static final String WEB_MANAGE_URL = "https://estoquesimples.com.br/app/plano";

    /** Tempo para a loja reconectar antes de acusar falha na tela. */
    private static final long PLAY_CONNECT_TIMEOUT_MS = 12_000L;

    /** Separa o prefixo (símbolo/código da moeda) do valor numérico formatado pela Play Store. */
    private static final Pattern PRICE_PATTERN = Pattern.compile("^([^0-9]*)([0-9][0-9.,]*)(.*)$");

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private SessionManager session;
    private EntitlementManager entitlements;
    private PendingPurchase pending;
    private PremiumManager premiumManager;
    private PlayBilling playBilling;
    private PlayBilling.Offer currentOffer;
    private boolean offerLoadFailed;
    private boolean legacyQueryInFlight;
    private boolean linkingInFlight;

    private TextView heroTitle;
    private TextView heroSubtitle;
    private TextView stateView;
    private View priceView;
    private TextView priceAmountView;
    private TextView noticeView;
    private TextView messageView;
    private TextView legacyProTitle;
    private TextView legacyProMessage;
    private TextView restoreLegacyProButton;
    private ProgressBar progress;
    private Button subscribeButton;
    private Button restoreButton;
    private Button manageButton;
    private Button goAccountButton;
    private Button retryButton;

    private final Runnable playConnectTimeout = () -> {
        if (isFinishing() || (playBilling != null && playBilling.isReady())) {
            return;
        }
        showMessage("Não foi possível conectar à Play Store.");
        retryButton.setVisibility(View.VISIBLE);
        setBusy(false);
    };

    /** De onde a pessoa chegou à tela de assinatura; vira `trigger` no evento. */
    private static final String EXTRA_ORIGEM = "br.com.gameloop.estoquesimples.PAYWALL_ORIGIN";

    public static void open(Context context) {
        open(context, "unknown");
    }

    public static void open(Context context, String origin) {
        context.startActivity(new Intent(context, SubscriptionActivity.class)
                .putExtra(EXTRA_ORIGEM, origin));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_subscription);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle(R.string.subscription_title);
        }

        session = SessionManager.get(this);
        entitlements = new EntitlementManager(this);
        pending = new PendingPurchase(this);
        premiumManager = PremiumManager.getInstance(this);

        bindViews();
        renderFromLocal();
        connectPlay();
        recognizeLegacyProQuietly();

        Analytics.track(this, "paywall.viewed", Analytics.props(
                "trigger", getIntent() != null ? getIntent().getStringExtra(EXTRA_ORIGEM) : null));
    }

    @Override
    protected void onResume() {
        super.onResume();
        session = SessionManager.get(this);
        renderFromLocal();
        if (session.isSignedIn() && session.workspaceId() != null) {
            refreshEntitlementInBackground();
            maybeResumePending();
        }
    }

    private void bindViews() {
        heroTitle = findViewById(R.id.heroTitle);
        heroSubtitle = findViewById(R.id.heroSubtitle);
        stateView = findViewById(R.id.subscriptionState);
        priceView = findViewById(R.id.subscriptionPrice);
        priceAmountView = findViewById(R.id.subscriptionPriceAmount);
        noticeView = findViewById(R.id.subscriptionNotice);
        messageView = findViewById(R.id.messageView);
        progress = findViewById(R.id.progress);
        subscribeButton = findViewById(R.id.subscribeButton);
        restoreButton = findViewById(R.id.restoreButton);
        manageButton = findViewById(R.id.manageButton);
        goAccountButton = findViewById(R.id.goAccountButton);
        retryButton = findViewById(R.id.retryButton);
        legacyProTitle = findViewById(R.id.legacyProTitle);
        legacyProMessage = findViewById(R.id.legacyProMessage);
        restoreLegacyProButton = findViewById(R.id.restoreLegacyProButton);
        LegalDocuments.bindFooterLinks(findViewById(R.id.legalFooter));

        subscribeButton.setOnClickListener(v -> initiateSubscribe());
        restoreButton.setOnClickListener(v -> restorePurchase());
        manageButton.setOnClickListener(v ->
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(
                        entitlements.managedOnWeb() ? WEB_MANAGE_URL : PLAY_MANAGE_URL))));
        goAccountButton.setOnClickListener(v ->
                startActivity(new Intent(this, AccountActivity.class)));
        retryButton.setOnClickListener(v -> retry());
        restoreLegacyProButton.setOnClickListener(v -> restoreLegacyPro());
    }

    private void connectPlay() {
        if (playBilling != null) {
            playBilling.endConnection();
        }
        playBilling = new PlayBilling(this);
        playBilling.setPurchaseUpdateListener(this::onPurchasesUpdated);
        main.removeCallbacks(playConnectTimeout);
        main.postDelayed(playConnectTimeout, PLAY_CONNECT_TIMEOUT_MS);
        playBilling.start(new PlayBilling.ConnectionListener() {
            @Override
            public void onReady() {
                main.post(() -> {
                    main.removeCallbacks(playConnectTimeout);
                    if (isFinishing()) {
                        return;
                    }
                    showMessage(null);
                    loadOffer();
                    maybeResumePending();
                });
            }

            @Override
            public void onError(String message) {
                main.post(() -> {
                    main.removeCallbacks(playConnectTimeout);
                    if (isFinishing()) {
                        return;
                    }
                    offerLoadFailed = true;
                    showMessage(message);
                    retryButton.setVisibility(View.VISIBLE);
                    setBusy(false);
                });
            }
        });
    }

    private void recognizeLegacyProQuietly() {
        if (premiumManager.isPro() || legacyQueryInFlight) {
            return;
        }
        legacyQueryInFlight = true;
        LegacyProBilling.runQuery(this, false, (result, message) -> {
            legacyQueryInFlight = false;
            if (isFinishing()) {
                return;
            }
            if (result == LegacyProBilling.Result.RECOGNIZED) {
                renderFromLocal();
            }
        });
    }

    private void retry() {
        showMessage(null);
        retryButton.setVisibility(View.GONE);
        offerLoadFailed = false;
        setBusy(false);
        connectPlay();
        if (session.isSignedIn() && session.workspaceId() != null) {
            refreshEntitlementInBackground();
        }
        recognizeLegacyProQuietly();
    }

    private void renderFromLocal() {
        boolean ativa = entitlements.isPaid();
        boolean isPro = premiumManager.isPro();

        if (ativa) {
            heroTitle.setText(R.string.subscription_hero_title_active);
            heroSubtitle.setText(R.string.subscription_hero_subtitle_active);
        } else if (isPro) {
            heroTitle.setText(R.string.subscription_hero_title_legacy_pro);
            heroSubtitle.setText(R.string.subscription_hero_subtitle_legacy_pro);
        } else {
            heroTitle.setText(R.string.subscription_hero_title);
            heroSubtitle.setText(R.string.subscription_hero_subtitle);
        }

        // "Sem assinatura" não soma nada numa tela cujo objetivo é vender a
        // assinatura — para quem nunca assinou, o estado fica implícito.
        // Os outros estados (ativa, em carência, cancelada mas ainda ativa...)
        // são informação real que a pessoa precisa ver.
        String estado = entitlements.state();
        boolean semAssinatura = estado == null || estado.isEmpty() || "sem_assinatura".equals(estado);
        if (semAssinatura) {
            stateView.setVisibility(View.GONE);
        } else {
            stateView.setVisibility(View.VISIBLE);
            stateView.setText(entitlements.stateLegivel());
        }
        if (ativa) {
            priceView.setVisibility(View.GONE);
        } else if (currentOffer != null && currentOffer.formattedPrice != null
                && !currentOffer.formattedPrice.isEmpty()) {
            priceView.setVisibility(View.VISIBLE);
        }
        updatePendingNotice();
        updateActionVisibility();
        updateLegacyFooter();
        renderFreeSummary();
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
        boolean ativa = entitlements.isPaid();

        retryButton.setVisibility(offerLoadFailed && !ativa ? View.VISIBLE : View.GONE);

        if (!signedInWithWorkspace) {
            goAccountButton.setVisibility(View.VISIBLE);
            subscribeButton.setVisibility(View.GONE);
            restoreButton.setVisibility(View.GONE);
            manageButton.setVisibility(View.GONE);
            return;
        }

        goAccountButton.setVisibility(View.GONE);
        manageButton.setVisibility(View.VISIBLE);
        // Assinatura feita pela web não aparece na Google Play: o botão leva
        // para onde ela de fato é gerenciada.
        manageButton.setText(entitlements.managedOnWeb()
                ? R.string.subscription_manage_web
                : R.string.subscription_manage);

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

    /** O que já vem de graça, com o teto real do plano gratuito. */
    private void renderFreeSummary() {
        TextView resumo = findViewById(R.id.freePlanSummary);
        if (resumo == null) {
            return;
        }
        int limite = entitlements.productLimit();
        String teto = limite == EntitlementManager.SEM_LIMITE || !entitlements.hasSnapshot()
                ? "até 50 produtos"
                : "até " + limite + " produtos";
        resumo.setText("No plano gratuito você já tem: seus dados na nuvem, em todos os seus "
                + "aparelhos, com " + teto + ". O plano Equipe tira o teto e abre a empresa "
                + "para outras pessoas.");
    }

    private void updateLegacyFooter() {
        if (premiumManager.isPro()) {
            legacyProTitle.setText(R.string.subscription_legacy_title);
            legacyProMessage.setText(R.string.subscription_legacy_active);
            restoreLegacyProButton.setText(R.string.subscription_legacy_restore);
        } else {
            legacyProTitle.setText(R.string.subscription_legacy_title);
            legacyProMessage.setText(R.string.subscription_legacy_body);
            restoreLegacyProButton.setText(R.string.subscription_legacy_restore);
        }
    }

    private void loadOffer() {
        if (playBilling == null) {
            return;
        }
        playBilling.queryOffer((offer, error) -> main.post(() -> {
            if (isFinishing()) {
                return;
            }
            if (error != null) {
                offerLoadFailed = true;
                currentOffer = null;
                showMessage(error);
                retryButton.setVisibility(View.VISIBLE);
                return;
            }
            offerLoadFailed = false;
            showMessage(null);
            retryButton.setVisibility(View.GONE);
            currentOffer = offer;
            if (offer != null && offer.formattedPrice != null
                    && !offer.formattedPrice.isEmpty()) {
                priceView.setVisibility(View.VISIBLE);
                priceAmountView.setText(buildPriceDisplay(offer.formattedPrice));
                subscribeButton.setText(getString(R.string.subscription_cta_with_price,
                        offer.formattedPrice));
            }
        }));
    }

    /**
     * Destaca o valor: símbolo e "/ mês" pequenos, número grande — do jeito
     * que uma vitrine de preço se lê primeiro, em vez de tudo do mesmo
     * tamanho. O preço em si (`offer.formattedPrice`) vem pronto e localizado
     * da Play Store, então não recriamos o formato — só separamos o prefixo
     * não numérico (símbolo da moeda) do valor via regex; se o formato fugir
     * do esperado, cai de volta no texto plano, sem quebrar a tela.
     */
    private CharSequence buildPriceDisplay(String formattedPrice) {
        String trimmed = formattedPrice.trim();
        // A Play Store devolve o preço no idioma do aparelho; num aparelho em
        // inglês vem "R$19.99". Para real, o formato é sempre "R$ 19,99".
        Matcher real = Pattern.compile("^R\\$\\s*([0-9]+)\\.([0-9]{2})$").matcher(trimmed);
        if (real.matches()) {
            trimmed = "R$ " + real.group(1) + "," + real.group(2);
        }
        Matcher matcher = PRICE_PATTERN.matcher(trimmed);
        String prefix = "";
        String amount = trimmed;
        if (matcher.matches()) {
            prefix = matcher.group(1);
            amount = matcher.group(2) + matcher.group(3);
        }
        String suffix = " " + getString(R.string.subscription_price_suffix);

        SpannableStringBuilder text = new SpannableStringBuilder();
        int prefixStart = text.length();
        text.append(prefix);
        int prefixEnd = text.length();

        int amountStart = text.length();
        text.append(amount);
        int amountEnd = text.length();

        int suffixStart = text.length();
        text.append(suffix);
        int suffixEnd = text.length();

        int prefixColor = ContextCompat.getColor(this, R.color.color_text_muted);
        int amountColor = ContextCompat.getColor(this, R.color.color_brand);

        applySpan(text, prefixStart, prefixEnd, 18, prefixColor, false);
        applySpan(text, amountStart, amountEnd, 42, amountColor, true);
        applySpan(text, suffixStart, suffixEnd, 15, prefixColor, false);

        return text;
    }

    private void applySpan(SpannableStringBuilder text, int start, int end, int sizeSp, int color, boolean bold) {
        if (start >= end) {
            return;
        }
        int sizePx = Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, sizeSp, getResources().getDisplayMetrics()));
        text.setSpan(new AbsoluteSizeSpan(sizePx), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        text.setSpan(new ForegroundColorSpan(color), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (bold) {
            text.setSpan(new StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
    }

    private void refreshEntitlementInBackground() {
        setBusy(true);
        executor.execute(() -> {
            try {
                entitlements.refresh();
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    renderFromLocal();
                    showMessage(null);
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    renderFromLocal();
                    if (!ConnectivityPrompt.report(this, e, this::refreshEntitlementInBackground)) {
                        showMessage(e.userMessage());
                        retryButton.setVisibility(View.VISIBLE);
                    }
                });
            } catch (Exception e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage("Não foi possível falar com o servidor. Tente de novo.");
                    retryButton.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    private void maybeResumePending() {
        if (pending.hasToken() && !pending.isPermanentError()
                && session.isSignedIn() && session.workspaceId() != null) {
            linkToken(pending.token(), true);
        }
    }

    private void initiateSubscribe() {
        if (!session.isSignedIn() || session.workspaceId() == null) {
            startActivity(new Intent(this, AccountActivity.class));
            return;
        }
        if (!"proprietario".equals(session.role())) {
            Toast.makeText(this, "Só o proprietário pode assinar.", Toast.LENGTH_LONG).show();
            return;
        }
        if (entitlements.isPaid()) {
            Toast.makeText(this, "Sua assinatura já está ativa.", Toast.LENGTH_SHORT).show();
            return;
        }
        if (currentOffer == null || playBilling == null || !playBilling.isReady()) {
            Toast.makeText(this, "Aguarde, carregando o preço da assinatura…",
                    Toast.LENGTH_SHORT).show();
            offerLoadFailed = true;
            retryButton.setVisibility(View.VISIBLE);
            loadOffer();
            return;
        }

        String obfuscated = PlayBilling.obfuscatedAccountId(session.workspaceId());
        BillingResult result = playBilling.launchSubscribe(this, currentOffer, obfuscated);
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            Analytics.track(this, "purchase.failed",
                    Analytics.props("reason", "launch", "code", result.getResponseCode()));
            showMessage("Não foi possível abrir a compra: " + result.getDebugMessage());
            retryButton.setVisibility(View.VISIBLE);
        } else {
            Analytics.track(this, "purchase.started");
        }
    }

    private void onPurchasesUpdated(@NonNull BillingResult billingResult,
                                    @Nullable List<Purchase> purchases) {
        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            Analytics.track(this, "purchase.failed", Analytics.props("reason", "user_canceled"));
            main.post(() -> {
                setBusy(false);
                Toast.makeText(this, "Compra cancelada.", Toast.LENGTH_SHORT).show();
            });
            return;
        }
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK
                || purchases == null) {
            Analytics.track(this, "purchase.failed",
                    Analytics.props("reason", "billing_error", "code", billingResult.getResponseCode()));
            main.post(() -> {
                setBusy(false);
                showMessage("Erro na compra: " + billingResult.getDebugMessage());
                retryButton.setVisibility(View.VISIBLE);
            });
            return;
        }

        for (Purchase purchase : purchases) {
            if (!purchase.getProducts().contains(Constants.SUBSCRIPTION_PRODUCT_ID)) {
                continue;
            }
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                main.post(() -> {
                    setBusy(false);
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
        if (!session.isSignedIn() || session.workspaceId() == null) {
            startActivity(new Intent(this, AccountActivity.class));
            return;
        }
        if (playBilling == null || !playBilling.isReady()) {
            Toast.makeText(this, "Aguarde a conexão com a Play Store.", Toast.LENGTH_SHORT).show();
            retryButton.setVisibility(View.VISIBLE);
            return;
        }
        setBusy(true);
        playBilling.queryPurchases((purchases, error) -> main.post(() -> {
            if (isFinishing()) {
                return;
            }
            if (error != null) {
                setBusy(false);
                showMessage(error);
                retryButton.setVisibility(View.VISIBLE);
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

    private void restoreLegacyPro() {
        if (legacyQueryInFlight) {
            Toast.makeText(this, getString(R.string.pro_restoring), Toast.LENGTH_SHORT).show();
            return;
        }
        legacyQueryInFlight = true;
        setBusy(true);
        showMessage(getString(R.string.pro_restoring));
        LegacyProBilling.runQuery(this, true, (result, message) -> {
            if (isFinishing()) {
                return;
            }
            legacyQueryInFlight = false;
            setBusy(false);
            showMessage(null);
            switch (result) {
                case RECOGNIZED:
                    renderFromLocal();
                    Toast.makeText(this, getString(R.string.subscription_legacy_recognized),
                            Toast.LENGTH_LONG).show();
                    break;
                case PENDING:
                    Toast.makeText(this,
                            message != null ? message : getString(R.string.pro_purchase_pending),
                            Toast.LENGTH_LONG).show();
                    break;
                case NOT_FOUND:
                    Toast.makeText(this,
                            message != null ? message : getString(R.string.pro_no_purchase_found),
                            Toast.LENGTH_LONG).show();
                    break;
                case STORE_NOT_READY:
                    Toast.makeText(this, getString(R.string.pro_store_not_connected),
                            Toast.LENGTH_SHORT).show();
                    retryButton.setVisibility(View.VISIBLE);
                    break;
                case ERROR:
                default:
                    Toast.makeText(this,
                            message != null ? message : getString(R.string.pro_restore_error),
                            Toast.LENGTH_LONG).show();
                    retryButton.setVisibility(View.VISIBLE);
                    break;
            }
        });
    }

    private void linkToken(String purchaseToken, boolean enqueueOnTransient) {
        if (linkingInFlight) {
            return;
        }
        linkingInFlight = true;
        setBusy(true);
        executor.execute(() -> {
            try {
                JSONObject entitlement = new SubscriptionClient(this).link(purchaseToken);
                entitlements.apply(entitlement);
                pending.clear();
                SyncBootstrap.start(this);

                main.post(() -> {
                    linkingInFlight = false;
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage(null);
                    renderFromLocal();
                    Toast.makeText(this, "Assinatura confirmada. A sincronização vai ligar.",
                            Toast.LENGTH_LONG).show();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    linkingInFlight = false;
                    if (isFinishing()) {
                        return;
                    }
                    handleLinkFailure(e, purchaseToken, enqueueOnTransient);
                });
            } catch (Exception e) {
                main.post(() -> {
                    linkingInFlight = false;
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage("Não foi possível confirmar a assinatura. Tente novamente.");
                    retryButton.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    private void handleLinkFailure(ApiException e, String purchaseToken, boolean enqueueOnTransient) {
        setBusy(false);
        String message = e.userMessage();
        if (isPermanentLinkError(e)) {
            pending.recordPermanentError(message);
            showMessage(message);
            updatePendingNotice();
            retryButton.setVisibility(View.VISIBLE);
            return;
        }
        pending.recordTransientError(message);
        updatePendingNotice();
        if (ConnectivityPrompt.isOffline(e)) {
            ConnectivityPrompt.show(this, () -> linkToken(purchaseToken, enqueueOnTransient));
            return;
        }
        showMessage(message);
        retryButton.setVisibility(View.VISIBLE);
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
        goAccountButton.setEnabled(true);
        restoreLegacyProButton.setEnabled(!legacyQueryInFlight);
        retryButton.setEnabled(true);
        manageButton.setEnabled(true);
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
        main.removeCallbacks(playConnectTimeout);
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
