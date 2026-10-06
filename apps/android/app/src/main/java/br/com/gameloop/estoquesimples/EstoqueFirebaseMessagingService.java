package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.branding.BrandStore;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import br.com.gameloop.estoquesimples.push.PushEvents;
import br.com.gameloop.estoquesimples.push.PushRegistrar;

/**
 * Recebe push do Firebase Cloud Messaging.
 *
 * As campanhas do painel chegam como mensagens só de dados (sem payload
 * notification), para que este serviço seja chamado em qualquer estado do
 * app: ele monta a notificação e reporta à API que ela chegou; o toque é
 * reportado por MainActivity. Mensagens com payload notification (console
 * do Firebase) continuam funcionando como antes.
 */
public class EstoqueFirebaseMessagingService extends FirebaseMessagingService {

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                context.getString(R.string.push_channel_id),
                context.getString(R.string.push_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.push_channel_description));
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel(this);
    }

    /** Extras que a notificação de campanha coloca no Intent de abertura. */
    public static final String EXTRA_CAMPAIGN_ID = "br.com.gameloop.estoquesimples.PUSH_CAMPAIGN_ID";
    public static final String EXTRA_SCREEN = "br.com.gameloop.estoquesimples.PUSH_SCREEN";
    public static final String EXTRA_URL = "br.com.gameloop.estoquesimples.PUSH_URL";
    /** Resposta do suporte: abre a conversa da solicitação. */
    public static final String EXTRA_TICKET_ID = "br.com.gameloop.estoquesimples.PUSH_TICKET_ID";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String campaignId = message.getData().get("campaignId");
        if (campaignId != null && !campaignId.isEmpty()) {
            PushEvents.report(this, campaignId, PushEvents.DELIVERED);
        }

        String title = null;
        String body = null;
        RemoteMessage.Notification notification = message.getNotification();
        if (notification != null) {
            title = notification.getTitle();
            body = notification.getBody();
        }
        if (title == null || title.isEmpty()) {
            title = message.getData().get("title");
        }
        if (body == null || body.isEmpty()) {
            body = message.getData().get("body");
        }
        if ((title == null || title.isEmpty()) && (body == null || body.isEmpty())) {
            return;
        }
        if (title == null || title.isEmpty()) {
            title = getString(R.string.app_name);
        }
        show(title, body == null ? "" : body, message.getMessageId(), campaignId,
                message.getData().get("screen"), message.getData().get("url"),
                "support".equals(message.getData().get("type")) ? message.getData().get("ticketId") : null);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        PushRegistrar.send(this, token);
    }

    private void show(String title, String body, String messageId, String campaignId,
                      String screen, String url, String ticketId) {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            return;
        }
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (campaignId != null) {
            intent.putExtra(EXTRA_CAMPAIGN_ID, campaignId);
        }
        if (screen != null) {
            intent.putExtra(EXTRA_SCREEN, screen);
        }
        if (url != null) {
            intent.putExtra(EXTRA_URL, url);
        }
        if (ticketId != null) {
            intent.putExtra(EXTRA_TICKET_ID, ticketId);
        }
        // Request code por campanha/solicitação: dois pushes seguidos não
        // reaproveitam o PendingIntent um do outro (e os extras errados).
        int requestCode = ticketId != null ? ticketId.hashCode() : campaignId != null ? campaignId.hashCode() : 0;
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String channelId = getString(R.string.push_channel_id);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_stat_notification)
                .setColor(BrandStore.color(this, R.color.color_brand))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        // Uma notificação por solicitação: a resposta nova substitui a anterior.
        int id = ticketId != null
                ? ticketId.hashCode()
                : messageId != null
                        ? messageId.hashCode()
                        : (int) (System.currentTimeMillis() & 0x7fffffff);
        try {
            NotificationManagerCompat.from(this).notify(id, builder.build());
        } catch (SecurityException ignored) {
            // Android 13+ sem POST_NOTIFICATIONS.
        }
    }
}
