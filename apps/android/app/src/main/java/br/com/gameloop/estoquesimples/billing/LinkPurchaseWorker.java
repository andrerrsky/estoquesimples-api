package br.com.gameloop.estoquesimples.billing;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.android.billingclient.api.Purchase;

import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.TimeUnit;

import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.EntitlementManager;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.SubscriptionClient;
import br.com.gameloop.estoquesimples.sync.SyncBootstrap;

/**
 * Completa a vinculação de um comprovante pendente com a API.
 *
 * Cobre o caso de o app ter sido fechado entre a compra na Play Store e o
 * {@code POST /billing/subscriptions}. Sem isso, o Google estorna a compra
 * em três dias por falta de acknowledge no servidor.
 */
public final class LinkPurchaseWorker extends Worker {

    private static final String TAG = "LinkPurchaseWorker";
    private static final String TRABALHO = "vinculacao_assinatura";

    public LinkPurchaseWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    public static void enqueue(@NonNull Context context) {
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(LinkPurchaseWorker.class)
                    .setConstraints(new Constraints.Builder()
                            .setRequiredNetworkType(NetworkType.CONNECTED)
                            .build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .build();

            WorkManager.getInstance(context).enqueueUniqueWork(
                    TRABALHO, ExistingWorkPolicy.KEEP, request);
        } catch (Exception e) {
            Log.e(TAG, "falha ao agendar vinculação da assinatura", e);
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SessionManager session = SessionManager.get(context);
        if (!session.isSignedIn() || session.workspaceId() == null) {
            return Result.success();
        }

        PendingPurchase pending = new PendingPurchase(context);
        if (pending.isPermanentError() && pending.hasToken()) {
            // Nada melhora repetindo; a tela mostra o motivo.
            return Result.success();
        }

        String token = pending.token();
        if (token == null || token.isEmpty()) {
            try {
                List<Purchase> purchases = PlayBilling.queryPurchasesBlocking(context);
                Purchase found = PlayBilling.findPurchasedSubscription(purchases);
                if (found == null) {
                    return Result.success();
                }
                token = found.getPurchaseToken();
                pending.save(token);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Result.retry();
            } catch (Exception e) {
                Log.e(TAG, "falha ao consultar compras na Play Store", e);
                return Result.retry();
            }
        } else {
            // Token guardado pode ser de uma compra que ainda estava PENDING.
            try {
                List<Purchase> purchases = PlayBilling.queryPurchasesBlocking(context);
                Purchase match = null;
                for (Purchase purchase : purchases) {
                    if (token.equals(purchase.getPurchaseToken())) {
                        match = purchase;
                        break;
                    }
                }
                if (match != null
                        && match.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                    return Result.retry();
                }
                if (match != null
                        && match.getPurchaseState() != Purchase.PurchaseState.PURCHASED) {
                    pending.clear();
                    return Result.success();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Result.retry();
            } catch (Exception e) {
                Log.w(TAG, "não foi possível revalidar o estado da compra localmente", e);
                // Segue para a API: o servidor é a fonte da verdade.
            }
        }

        try {
            JSONObject entitlement = new SubscriptionClient(context).link(token);
            new EntitlementManager(context).apply(entitlement);
            pending.clear();
            SyncBootstrap.start(context);
            Log.i(TAG, "assinatura vinculada; sincronização será reavaliada");
            return Result.success();
        } catch (ApiException e) {
            return handleApiFailure(pending, e);
        } catch (Exception e) {
            Log.e(TAG, "falha inesperada na vinculação", e);
            pending.recordTransientError("Erro inesperado ao confirmar a assinatura.");
            return Result.retry();
        }
    }

    private Result handleApiFailure(PendingPurchase pending, ApiException e) {
        String message = e.userMessage();
        if (isPermanent(e)) {
            pending.recordPermanentError(message);
            Log.w(TAG, "erro permanente na vinculação: " + e.getCode());
            return Result.success();
        }
        pending.recordTransientError(message);
        Log.w(TAG, "erro transitório na vinculação: " + e.getCode());
        return Result.retry();
    }

    private static boolean isPermanent(ApiException e) {
        String code = e.getCode();
        if (ApiException.TOKEN_EM_USO.equals(code)
                || ApiException.TOKEN_INVALIDO.equals(code)) {
            return true;
        }
        // 403: quem tentou não é proprietário (ou perdeu o acesso).
        return e.getStatusCode() == 403 && !e.isTransient();
    }
}
