package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.util.Log;

import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.billing.LinkPurchaseWorker;
import br.com.gameloop.estoquesimples.billing.PendingPurchase;
import br.com.gameloop.estoquesimples.data.SyncGate;

/**
 * Liga a camada de sincronização quando o app abre.
 *
 * O trabalho pesado fica no {@link SyncWorker}; aqui só se decide se a fila de
 * saída deve começar a receber operações. Essa decisão precisa acontecer cedo,
 * antes da primeira alteração do usuário, senão uma edição feita nos primeiros
 * segundos do app não seria enfileirada e nunca chegaria à nuvem.
 *
 * Enquanto a decisão não é tomada, o interruptor fica desligado. Errar para o
 * lado de não enfileirar é recuperável — a sincronização seguinte reenvia o
 * estado atual do registro. Errar para o outro lado encheria a fila de
 * operações de um usuário que nem tem conta.
 */
public final class SyncBootstrap {

    private static final String TAG = "SyncBootstrap";

    private SyncBootstrap() {
    }

    public static void start(Context context) {
        Context appContext = context.getApplicationContext();

        // Uma thread avulsa e não o WorkManager: isto precisa terminar em
        // segundos, e agendar trabalho para decidir se há trabalho seria dar
        // uma volta desnecessária.
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                RemoteConfig config = new RemoteConfig(appContext);
                config.refresh();

                SessionManager session = SessionManager.get(appContext);
                boolean pronto = config.isSyncEnabled()
                        && config.isProtocolSupported()
                        && session.isSignedIn()
                        && session.workspaceId() != null
                        && new EntitlementManager(appContext).canSync();

                SyncGate.setActive(pronto);

                // Compra feita e app fechado antes da vinculação: retoma aqui.
                PendingPurchase pending = new PendingPurchase(appContext);
                if (pending.hasToken() && !pending.isPermanentError()) {
                    LinkPurchaseWorker.enqueue(appContext);
                }

                if (pronto) {
                    SyncScheduler.schedulePeriodic(appContext);
                    SyncScheduler.syncNow(appContext);
                } else {
                    // Não cancela o agendamento periódico: é justamente ele que
                    // vai perceber quando a assinatura for renovada ou a flag
                    // voltar a ficar ligada.
                    Log.d(TAG, "sincronização inativa nesta abertura");
                }
            } catch (Exception e) {
                Log.e(TAG, "falha ao inicializar a sincronização", e);
                SyncGate.setActive(false);
            }
        });
    }
}
