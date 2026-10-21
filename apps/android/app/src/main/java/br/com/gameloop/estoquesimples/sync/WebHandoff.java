package br.com.gameloop.estoquesimples.sync;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.BuildConfig;
import br.com.gameloop.estoquesimples.ConnectivityPrompt;

/**
 * "Abrir na web" já conectado.
 *
 * O app pede à API um código de uso único (vale 2 minutos, uma vez) e abre o
 * navegador em {@code /entrar/app#codigo=…}. A web troca o código por uma
 * sessão própria, sem pedir e-mail e senha de novo. O código vai no
 * fragmento da URL: o navegador não o envia a servidor nenhum, não aparece em
 * logs nem no Referer, e a página o apaga da barra de endereço ao abrir.
 *
 * Sem conta no app, ou se o pedido falhar, abre a mesma tela da web sem
 * conexão automática: a pessoa entra com e-mail e senha lá.
 */
public final class WebHandoff {

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private WebHandoff() {
    }

    public interface Busy {
        void set(boolean busy);
    }

    /** @param path destino na web, sempre dentro de {@code /app} (ex.: {@code /app/plano}). */
    public static void open(Activity activity, String path, Busy busy) {
        String destino = path != null && path.startsWith("/app") ? path : "/app";
        SessionManager session = SessionManager.get(activity);
        if (!session.isSignedIn()) {
            launch(activity, BuildConfig.WEB_BASE_URL + destino);
            return;
        }
        if (busy != null) busy.set(true);
        Handler main = new Handler(Looper.getMainLooper());
        EXECUTOR.execute(() -> {
            String url;
            String aviso = null;
            try {
                JSONObject resposta = new ApiClient()
                        .post("/v1/auth/web-handoff", new JSONObject(), session.accessToken()).body;
                String codigo = resposta.getString("code");
                StringBuilder fragmento = new StringBuilder("codigo=").append(Uri.encode(codigo))
                        .append("&para=").append(Uri.encode(destino));
                String empresa = session.workspaceId();
                if (empresa != null) {
                    fragmento.append("&empresa=").append(Uri.encode(empresa));
                }
                url = BuildConfig.WEB_BASE_URL + "/entrar/app#" + fragmento;
            } catch (Exception e) {
                // Sem rede ou sessão vencida: a web abre na tela de entrada.
                url = BuildConfig.WEB_BASE_URL + destino;
                aviso = e instanceof ApiException && ConnectivityPrompt.isOffline(e)
                        ? "Sem internet. Conecte-se para abrir a versão web."
                        : "Abrindo a versão web. Se pedir, entre com seu e-mail e senha.";
            }
            final String alvo = url;
            final String mensagem = aviso;
            main.post(() -> {
                if (busy != null) busy.set(false);
                if (activity.isFinishing() || activity.isDestroyed()) {
                    return;
                }
                if (mensagem != null) {
                    Toast.makeText(activity, mensagem, Toast.LENGTH_LONG).show();
                }
                launch(activity, alvo);
            });
        });
    }

    private static void launch(Activity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, "Nenhum navegador encontrado neste aparelho.", Toast.LENGTH_LONG).show();
        }
    }
}
