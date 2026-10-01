package br.com.gameloop.estoquesimples.push;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Reporta à API que uma notificação de campanha chegou ao aparelho ou foi
 * tocada ({@code POST /v1/push/events}). É o que permite ao painel medir
 * entrega e abertura; o FCM só sabe que aceitou a mensagem.
 */
public final class PushEvents {

    private static final String TAG = "PushEvents";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    public static final String DELIVERED = "delivered";
    public static final String OPENED = "opened";

    private PushEvents() {
    }

    public static void report(Context context, String campaignId, String event) {
        if (campaignId == null || campaignId.isEmpty()) {
            return;
        }
        final Context app = context.getApplicationContext();
        Analytics.track(app, OPENED.equals(event) ? "notification.opened" : "notification.received",
                Analytics.props("kind", "push", "campaignId", campaignId));
        EXECUTOR.execute(() -> {
            for (int tentativa = 0; tentativa < 2; tentativa++) {
                try {
                    JSONObject body = new JSONObject()
                            .put("campaignId", campaignId)
                            .put("installId", SessionManager.get(app).deviceId())
                            .put("event", event);
                    new ApiClient().post("/v1/push/events", body, null);
                    return;
                } catch (Exception e) {
                    Log.w(TAG, "evento de push não reportado (" + event + ")", e);
                    try {
                        Thread.sleep(3_000);
                    } catch (InterruptedException ignored) {
                        return;
                    }
                }
            }
        });
    }
}
