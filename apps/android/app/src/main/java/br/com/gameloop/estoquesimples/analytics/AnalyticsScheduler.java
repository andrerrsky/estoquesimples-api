package br.com.gameloop.estoquesimples.analytics;

import android.content.Context;
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

/**
 * Agendamento do envio de eventos, no mesmo molde de {@code SyncScheduler}.
 *
 * Dois gatilhos: um envio "em breve" (com atraso de um minuto, para juntar os
 * eventos de uma mesma ação num lote só) e um periódico, que garante que a
 * fila esvazia mesmo que o app fique dias sem ser aberto com rede.
 */
public final class AnalyticsScheduler {

    private static final String TAG = "AnalyticsScheduler";
    private static final String TRABALHO_PERIODICO = "analytics_periodico";
    private static final String TRABALHO_EM_BREVE = "analytics_em_breve";

    private AnalyticsScheduler() {
    }

    public static void schedulePeriodic(Context context) {
        try {
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    AnalyticsWorker.class, 6, TimeUnit.HOURS)
                    .setConstraints(constraints())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
                    .build();
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    TRABALHO_PERIODICO, ExistingPeriodicWorkPolicy.KEEP, request);
        } catch (Exception e) {
            Log.e(TAG, "falha ao agendar o envio periódico de eventos", e);
        }
    }

    /** KEEP: se já há um envio agendado, os eventos novos pegam carona nele. */
    public static void flushSoon(Context context) {
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AnalyticsWorker.class)
                    .setInitialDelay(1, TimeUnit.MINUTES)
                    .setConstraints(constraints())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                    .build();
            WorkManager.getInstance(context).enqueueUniqueWork(
                    TRABALHO_EM_BREVE, ExistingWorkPolicy.KEEP, request);
        } catch (Exception e) {
            Log.e(TAG, "falha ao agendar o envio de eventos", e);
        }
    }

    private static Constraints constraints() {
        return new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
    }
}
