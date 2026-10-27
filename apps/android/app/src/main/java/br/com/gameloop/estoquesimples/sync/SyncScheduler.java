package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

import br.com.gameloop.estoquesimples.data.SyncGate;

/**
 * Agendamento da sincronização.
 *
 * Dois gatilhos, com propósitos diferentes: o periódico garante que nada fica
 * parado indefinidamente mesmo que o app não seja aberto, e o imediato faz uma
 * alteração recém-gravada subir logo, para que o usuário veja o resultado
 * enquanto ainda se lembra do que fez.
 */
public final class SyncScheduler {

    private static final String TAG = "SyncScheduler";

    private static final String TRABALHO_PERIODICO = "sincronizacao_periodica";
    private static final String TRABALHO_IMEDIATO = "sincronizacao_imediata";

    /**
     * 15 minutos é o menor intervalo que o Android aceita para trabalho
     * periódico. Pedir menos não acelera nada — o sistema arredonda para cima.
     */
    private static final long INTERVALO_MINUTOS = 15;

    /**
     * Pausa entre a última gravação e o envio. Curta o bastante para a pessoa
     * ver o resultado "na hora" e longa o bastante para juntar numa rodada só
     * uma sequência de saídas registradas uma atrás da outra.
     */
    private static final long ESPERA_APOS_GRAVACAO_MS = 3_000;

    /** Ao voltar ao app, só sincroniza de novo se a última rodada já tem esta idade. */
    public static final long IDADE_PARA_REPETIR_MS = 60_000;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static Runnable envioAgendado;

    private SyncScheduler() {
    }

    /**
     * Uma alteração acabou de ser gravada: sincroniza daqui a instantes.
     *
     * Várias chamadas seguidas viram uma rodada só, e uma rodada em andamento
     * não é interrompida — o envio espera ela terminar, senão a operação que
     * acabou de entrar na fila poderia ficar de fora das duas.
     */
    public static void syncSoon(Context context) {
        if (!SyncGate.isActive()) {
            return;
        }
        Context appContext = context.getApplicationContext();
        MAIN.post(() -> {
            if (envioAgendado != null) {
                MAIN.removeCallbacks(envioAgendado);
            }
            envioAgendado = new Runnable() {
                @Override
                public void run() {
                    if (SyncStatus.current().running) {
                        MAIN.postDelayed(this, ESPERA_APOS_GRAVACAO_MS);
                        return;
                    }
                    envioAgendado = null;
                    syncNow(appContext);
                }
            };
            MAIN.postDelayed(envioAgendado, ESPERA_APOS_GRAVACAO_MS);
        });
    }

    /**
     * Ao voltar para o app: traz o que mudou em outros aparelhos, sem repetir
     * a rodada a cada troca de tela.
     */
    public static void syncIfStale(Context context) {
        if (!SyncGate.isActive() || SyncStatus.current().running) {
            return;
        }
        long ultima = SyncStatus.lastActivityAt();
        if (ultima != 0L && System.currentTimeMillis() - ultima < IDADE_PARA_REPETIR_MS) {
            return;
        }
        syncNow(context.getApplicationContext());
    }

    public static void schedulePeriodic(Context context) {
        try {
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    SyncWorker.class, INTERVALO_MINUTOS, TimeUnit.MINUTES)
                    .setConstraints(constraints())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                    .build();

            // KEEP e não UPDATE: substituir o trabalho a cada abertura do app
            // reiniciaria o intervalo, e quem abre o app com frequência nunca
            // chegaria ao momento da execução.
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    TRABALHO_PERIODICO, ExistingPeriodicWorkPolicy.KEEP, request);
        } catch (Exception e) {
            Log.e(TAG, "falha ao agendar a sincronização periódica", e);
        }
    }

    /**
     * Dispara uma sincronização agora, se houver rede e assinatura ativa.
     *
     * A fila local continua independente: este método só pede o envio à nuvem.
     * Sem direito de sincronizar, o botão da tela de conta explica o motivo;
     * daqui o trabalho simplesmente não entra na fila do WorkManager.
     */
    public static void syncNow(Context context) {
        if (!SyncGate.isActive()) {
            return;
        }
        if (!new EntitlementManager(context).canSync()) {
            Log.i(TAG, "sincronização imediata ignorada: a empresa não tem assinatura ativa");
            return;
        }
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(SyncWorker.class)
                    .setConstraints(constraints())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .build();

            // APPEND_OR_REPLACE evita duas sincronizações simultâneas, que
            // enviariam a mesma fila duas vezes.
            WorkManager.getInstance(context).enqueueUniqueWork(
                    TRABALHO_IMEDIATO, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
        } catch (Exception e) {
            Log.e(TAG, "falha ao solicitar sincronização imediata", e);
        }
    }

    public static void cancelAll(Context context) {
        try {
            WorkManager manager = WorkManager.getInstance(context);
            manager.cancelUniqueWork(TRABALHO_PERIODICO);
            manager.cancelUniqueWork(TRABALHO_IMEDIATO);
        } catch (Exception e) {
            Log.e(TAG, "falha ao cancelar a sincronização", e);
        }
    }

    private static Constraints constraints() {
        return new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                // Sem exigir bateria carregada: quem trabalha o dia inteiro com
                // o celular na mão nunca atenderia essa condição, e a
                // sincronização só aconteceria de madrugada.
                .setRequiresBatteryNotLow(true)
                .build();
    }
}
