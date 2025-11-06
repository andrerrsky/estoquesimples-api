package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * Classe responsável por gerenciar o agendamento de notificações de estoque baixo
 */
public class LowStockScheduler {

    private static final String TAG = "LowStockScheduler";
    private static final String WORK_NAME = "low_stock_notification_work";
    private static final long REPEAT_INTERVAL_HOURS = 4;
    
    // Construtor privado para classe utilitária
    private LowStockScheduler() {
        throw new UnsupportedOperationException("Utility class");
    }

    /**
     * Verifica se há produtos com estoque baixo e agenda/cancela notificações conforme necessário
     * @param context Contexto da aplicação
     */
    public static void checkAndScheduleNotifications(Context context) {
        boolean hasLowStock = checkIfHasLowStockProducts(context);

        if (hasLowStock) {
            scheduleNotifications(context);
        } else {
            cancelNotifications(context);
        }
    }

    /**
     * Agenda notificações periódicas a cada 4 horas
     * @param context Contexto da aplicação
     */
    public static void scheduleNotifications(Context context) {
        // Criar requisição de trabalho periódico
        PeriodicWorkRequest workRequest = new PeriodicWorkRequest.Builder(
            LowStockWorker.class,
            REPEAT_INTERVAL_HOURS,
            TimeUnit.HOURS
        )
        .build();

        // Agendar o trabalho (substituir se já existir)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            workRequest
        );

        android.util.Log.d(TAG, "Notificações agendadas a cada " + REPEAT_INTERVAL_HOURS + " horas");
    }

    /**
     * Cancela todas as notificações agendadas
     * @param context Contexto da aplicação
     */
    public static void cancelNotifications(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        
        // Também cancelar qualquer notificação ativa
        NotificationHelper notificationHelper = new NotificationHelper(context);
        notificationHelper.cancelLowStockNotification();

        android.util.Log.d(TAG, "Notificações canceladas");
    }

    /**
     * Verifica se há produtos com estoque baixo
     * @param context Contexto da aplicação
     * @return true se há produtos com estoque baixo, false caso contrário
     */
    private static boolean checkIfHasLowStockProducts(Context context) {
        SQLiteDatabase db = null;
        Cursor cursor = null;
        boolean hasLowStock = false;

        try {
            db = context.openOrCreateDatabase("estoque", Context.MODE_PRIVATE, null);

            cursor = db.rawQuery(
                "SELECT name, amount, min_stock FROM Estoque WHERE min_stock > 0",
                null
            );

            if (cursor.moveToFirst()) {
                do {
                    double amount = parseWithDefault(cursor.getString(1), 0);
                    double minStock = parseWithDefault(cursor.getString(2), 0);

                    if (amount <= minStock) {
                        hasLowStock = true;
                        break;
                    }
                } while (cursor.moveToNext());
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "Erro ao verificar estoque baixo", e);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
            if (db != null && db.isOpen()) {
                db.close();
            }
        }

        return hasLowStock;
    }

    /**
     * Converte string para double com valor padrão
     */
    private static double parseWithDefault(String number, double defaultVal) {
        try {
            if(number == null || number.isEmpty() || number.equals("null")) {
                return defaultVal;
            }
            return Double.parseDouble(number);
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }
}

