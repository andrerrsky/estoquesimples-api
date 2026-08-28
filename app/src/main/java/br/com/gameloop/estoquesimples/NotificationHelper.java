package br.com.gameloop.estoquesimples;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Helper class para gerenciar notificações de estoque baixo
 */
public class NotificationHelper {

    private static final String CHANNEL_ID = "low_stock_channel";
    private static final String CHANNEL_NAME = "Alertas de Estoque Baixo";
    private static final String CHANNEL_DESCRIPTION = "Notificações quando produtos estão com estoque baixo";
    private static final int NOTIFICATION_ID = 1001;

    private Context context;
    private NotificationManagerCompat notificationManager;

    public NotificationHelper(Context context) {
        this.context = context;
        this.notificationManager = NotificationManagerCompat.from(context);
        createNotificationChannel();
    }

    /**
     * Cria o canal de notificação (necessário para Android 8.0+)
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(CHANNEL_DESCRIPTION);
            channel.enableVibration(true);
            channel.enableLights(true);

            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    /**
     * Mostra uma notificação de estoque baixo
     * @param productNames Lista de produtos com estoque baixo
     * @param count Número de produtos com estoque baixo
     */
    public void showLowStockNotification(String productNames, int count) {
        // Intent para abrir o app quando clicar na notificação
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context, 
            0, 
            intent, 
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Construir a notificação
        String title = "Alerta de estoque baixo";
        String message;
        
        if (count == 1) {
            message = "1 produto está com estoque abaixo do mínimo:\n" + productNames;
        } else {
            message = count + " produtos estão com estoque abaixo do mínimo:\n" + productNames;
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setVibrate(new long[]{0, 500, 250, 500})
            .setCategory(NotificationCompat.CATEGORY_REMINDER);

        // Mostrar a notificação
        try {
            notificationManager.notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException e) {
            // Permissão de notificação não concedida no Android 13+
            android.util.Log.e("NotificationHelper", "Permissão de notificação não concedida", e);
        }
    }

    /**
     * Cancela a notificação de estoque baixo
     */
    public void cancelLowStockNotification() {
        notificationManager.cancel(NOTIFICATION_ID);
    }

    /**
     * Verifica se há permissão para enviar notificações (Android 13+)
     */
    public boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return notificationManager.areNotificationsEnabled();
        }
        return true; // Antes do Android 13, não precisa de permissão runtime
    }
}

