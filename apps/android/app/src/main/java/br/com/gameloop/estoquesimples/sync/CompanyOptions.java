package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

/**
 * Opções da empresa que o app respeita (hoje: lote e validade).
 *
 * Fica guardada no aparelho para a tela funcionar offline, mas a verdade é a
 * empresa na nuvem: quem liga na web vê os campos no app, e vice-versa. Sem
 * conta, vale só o que está aqui — o app tem de servir a quem nunca criou
 * conta nenhuma.
 */
public final class CompanyOptions {

    private static final String TAG = "CompanyOptions";
    private static final String ARQUIVO = "estoque_opcoes";
    private static final String CHAVE_LOTES = "lotes";

    private final Context appContext;
    private final SharedPreferences prefs;
    private final SessionManager session;
    private final ApiClient api = new ApiClient();

    public CompanyOptions(Context context) {
        this.appContext = context.getApplicationContext();
        this.prefs = appContext.getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
        this.session = SessionManager.get(appContext);
    }

    /** Atalho para as telas, que só querem saber se mostram os campos. */
    public static boolean batchesEnabled(Context context) {
        return new CompanyOptions(context).batchesEnabled();
    }

    public boolean batchesEnabled() {
        return prefs.getBoolean(CHAVE_LOTES, false);
    }

    /** Guarda a escolha no aparelho; a nuvem é avisada por {@link #push(boolean)}. */
    public void setBatchesEnabled(boolean enabled) {
        prefs.edit().putBoolean(CHAVE_LOTES, enabled).apply();
    }

    /**
     * Lê as opções da empresa na nuvem. Faz rede; nunca na thread principal.
     *
     * Falha em silêncio de propósito: opção é preferência, não direito. Se a
     * leitura não for possível, o app segue com o que já sabia em vez de
     * esconder campos que a pessoa acabou de ligar.
     */
    public void refresh() {
        String workspaceId = session.workspaceId();
        if (workspaceId == null || !session.isSignedIn()) {
            return;
        }
        try {
            ApiClient.Response response = api.get("/v1/workspaces/" + workspaceId,
                    session.accessToken());
            JSONObject settings = response.body == null ? null : response.body.optJSONObject("settings");
            if (settings != null && settings.has("trackBatches")) {
                setBatchesEnabled(settings.optBoolean("trackBatches", false));
            }
        } catch (ApiException e) {
            Log.i(TAG, "opções da empresa não lidas agora: " + e.getMessage());
        }
    }

    /**
     * Manda a escolha para a nuvem, preservando o resto de `settings` (o
     * servidor substitui o objeto inteiro: mandar só a nossa chave apagaria,
     * por exemplo, o símbolo de moeda escolhido na web).
     *
     * @return true se a nuvem aceitou. Falso também quando não há conta — aí
     *         a escolha vale só neste aparelho, que é o esperado.
     */
    public boolean push(boolean enabled) {
        String workspaceId = session.workspaceId();
        if (workspaceId == null || !session.isSignedIn()) {
            return false;
        }
        try {
            ApiClient.Response atual = api.get("/v1/workspaces/" + workspaceId,
                    session.accessToken());
            JSONObject settings = atual.body == null ? null : atual.body.optJSONObject("settings");
            if (settings == null) {
                settings = new JSONObject();
            }
            settings.put("trackBatches", enabled);
            JSONObject corpo = new JSONObject();
            corpo.put("settings", settings);
            // PUT, e não PATCH: HttpURLConnection não implementa PATCH, e a
            // rota aceita os dois.
            api.put("/v1/workspaces/" + workspaceId, corpo, session.accessToken());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "não foi possível salvar a opção na nuvem", e);
            return false;
        }
    }
}
