package br.com.gameloop.estoquesimples.push;

import android.content.Context;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.BuildConfig;
import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Registra o token do FCM na API ({@code PUT /v1/push/tokens}).
 *
 * Chamado ao abrir o app, quando o Firebase renova o token e logo após o
 * login: com sessão o token fica vinculado à conta, sem sessão fica só com a
 * instalação (e ainda recebe campanhas "para todos"). Falhas são silenciosas
 * e a próxima abertura tenta de novo.
 */
public final class PushRegistrar {

    private static final String TAG = "PushRegistrar";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushRegistrar() {
    }

    /** Pede o token atual ao Firebase e envia à API. */
    public static void register(Context context) {
        final Context app = context.getApplicationContext();
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    Log.w(TAG, "token do FCM indisponível", task.getException());
                    return;
                }
                send(app, task.getResult());
            });
        } catch (Exception e) {
            // Firebase ausente (build sem google-services) ou ainda não inicializado.
            Log.w(TAG, "Firebase indisponível", e);
        }
    }

    /** Envia um token já conhecido (ex.: {@code onNewToken}). */
    public static void send(Context context, String token) {
        if (token == null || token.isEmpty()) {
            return;
        }
        final Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                SessionManager session = SessionManager.get(app);
                String accessToken = null;
                if (session.isSignedIn()) {
                    try {
                        accessToken = session.accessToken();
                    } catch (ApiException ignored) {
                        accessToken = null;
                    }
                }
                JSONObject body = new JSONObject()
                        .put("token", token)
                        .put("installId", session.deviceId())
                        .put("platform", "android")
                        .put("appVersionCode", BuildConfig.VERSION_CODE)
                        .put("locale", Locale.getDefault().toLanguageTag())
                        .put("notificationsEnabled",
                                NotificationManagerCompat.from(app).areNotificationsEnabled());
                new ApiClient().put("/v1/push/tokens", body, accessToken);
            } catch (Exception e) {
                Log.w(TAG, "token do FCM não registrado na API", e);
            }
        });
    }
}
