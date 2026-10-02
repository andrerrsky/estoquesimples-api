package br.com.gameloop.estoquesimples.analytics;

import android.app.Activity;
import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Eventos de uso do produto.
 *
 * Contrato: {@code estoquesimples-api/docs/analytics.md}. Cada chamada grava
 * uma linha na fila local e volta na hora; o envio acontece em lote, em
 * segundo plano ({@link AnalyticsWorker}). Nada aqui bloqueia a interface
 * nem depende de rede, e uma falha ao registrar nunca chega ao usuário.
 *
 * O que vai nas propriedades: tipo, quantidade de itens, nome de tela,
 * formato, resultado. O que nunca vai: nome de produto, valores em dinheiro
 * do cliente, e-mail ou qualquer dado pessoal.
 */
public final class Analytics {

    private static final String TAG = "Analytics";

    /** Uma "sessão" agrupa os eventos de uma mesma abertura do app. */
    private static final long SESSAO_INATIVA_MS = 30L * 60_000L;

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final Object TRAVA = new Object();
    private static String sessionKey;
    private static long ultimoEventoEm;
    private static boolean aberturaRegistrada;

    private Analytics() {
    }

    /** Registra um evento sem propriedades. */
    public static void track(Context context, String name) {
        track(context, name, null);
    }

    /**
     * Registra um evento. {@code props} aceita String, Number ou Boolean;
     * valores nulos são ignorados.
     */
    public static void track(Context context, String name, Map<String, Object> props) {
        if (context == null || name == null || name.isEmpty()) {
            return;
        }
        final Context app = context.getApplicationContext();
        final long agora = System.currentTimeMillis();
        final String sessao = sessaoAtual(agora);
        final String propriedades = props == null || props.isEmpty() ? null : new JSONObject(limpar(props)).toString();

        EXECUTOR.execute(() -> {
            try {
                String workspaceId = null;
                try {
                    workspaceId = SessionManager.get(app).workspaceId();
                } catch (Exception ignored) {
                    // Sem sessão: o evento fica só com a instalação.
                }
                AnalyticsDb.helper(app).inserir(new AnalyticsDb.Pendente(
                        UUID.randomUUID().toString(), name, agora, workspaceId, sessao, propriedades));
                AnalyticsScheduler.flushSoon(app);
            } catch (Exception e) {
                Log.w(TAG, "evento não registrado: " + name, e);
            }
        });
    }

    /** Tela exibida. Chamado pelo {@code onResume} da Activity base. */
    public static void screen(Activity activity) {
        if (activity == null) {
            return;
        }
        track(activity, "screen.viewed", props("screen", activity.getClass().getSimpleName()));
    }

    /**
     * Aplicativo aberto. Registrado uma vez por processo (cold start) e de
     * novo quando o app volta depois de ficar mais de 30 minutos parado.
     */
    public static void appOpened(Context context) {
        long agora = System.currentTimeMillis();
        boolean cold;
        synchronized (TRAVA) {
            boolean novaSessao = sessionKey == null || agora - ultimoEventoEm > SESSAO_INATIVA_MS;
            if (aberturaRegistrada && !novaSessao) {
                return;
            }
            cold = !aberturaRegistrada;
            aberturaRegistrada = true;
        }
        track(context, "app.opened", props("coldStart", cold));
    }

    /** Monta um mapa de propriedades a partir de pares chave/valor. */
    public static Map<String, Object> props(Object... pares) {
        Map<String, Object> mapa = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pares.length; i += 2) {
            if (pares[i] != null && pares[i + 1] != null) {
                mapa.put(String.valueOf(pares[i]), pares[i + 1]);
            }
        }
        return mapa;
    }

    private static String sessaoAtual(long agora) {
        synchronized (TRAVA) {
            if (sessionKey == null || agora - ultimoEventoEm > SESSAO_INATIVA_MS) {
                sessionKey = UUID.randomUUID().toString().substring(0, 8);
            }
            ultimoEventoEm = agora;
            return sessionKey;
        }
    }

    /** Só escalares, no máximo 20 chaves e strings curtas — o que a API aceita. */
    private static Map<String, Object> limpar(Map<String, Object> props) {
        Map<String, Object> limpo = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entrada : props.entrySet()) {
            if (limpo.size() >= 20) {
                break;
            }
            Object valor = entrada.getValue();
            String chave = entrada.getKey();
            if (chave == null || valor == null || !chave.matches("^[a-zA-Z][a-zA-Z0-9_]{0,39}$")) {
                continue;
            }
            if (valor instanceof String) {
                String texto = (String) valor;
                limpo.put(chave, texto.length() > 200 ? texto.substring(0, 200) : texto);
            } else if (valor instanceof Number || valor instanceof Boolean) {
                limpo.put(chave, valor);
            } else {
                limpo.put(chave, String.valueOf(valor));
            }
        }
        return limpo;
    }
}
