package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import br.com.gameloop.estoquesimples.BuildConfig;

/**
 * Configuração vinda do servidor.
 *
 * Existe por um motivo específico: poder desligar a sincronização em todos os
 * aparelhos sem publicar uma versão nova na Play Store. Uma atualização leva
 * dias para alcançar a base instalada — tempo demais se o problema for envio de
 * dados errados. Desligada a flag, o app volta ao modo local, que é o modo em
 * que ele sempre funcionou.
 *
 * O valor buscado é guardado: sem rede, vale o último conhecido, e o padrão de
 * fábrica é sincronização <b>desligada</b>. Um app que nunca conseguiu falar
 * com o servidor não deveria assumir que pode enviar dados para ele.
 */
public final class RemoteConfig {

    private static final String TAG = "RemoteConfig";

    private static final String ARQUIVO = "estoque_config_remota";
    private static final String CHAVE_SYNC_ATIVA = "sync_ativa";
    private static final String CHAVE_PROTOCOLO_MINIMO = "protocolo_minimo";
    private static final String CHAVE_VERSAO_MINIMA = "versao_minima";
    private static final String CHAVE_LOTE_MAXIMO = "lote_maximo";
    private static final String CHAVE_PAGINA_PADRAO = "pagina_padrao";
    private static final String CHAVE_ATUALIZADO_EM = "atualizado_em";

    private static final int LOTE_MAXIMO_PADRAO = 200;
    private static final int PAGINA_PADRAO = 500;

    private final SharedPreferences prefs;
    private final ApiClient api;

    public RemoteConfig(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
        this.api = new ApiClient();
    }

    public boolean isSyncEnabled() {
        return prefs.getBoolean(CHAVE_SYNC_ATIVA, false);
    }

    /**
     * Esta versão do app fala uma versão de protocolo que o servidor ainda
     * aceita. Se não, sincronizar produziria erros repetidos até o usuário
     * atualizar; melhor não tentar e explicar.
     */
    public boolean isProtocolSupported() {
        return BuildConfig.SYNC_PROTOCOL >= prefs.getInt(CHAVE_PROTOCOLO_MINIMO, 1)
                && BuildConfig.VERSION_CODE >= prefs.getInt(CHAVE_VERSAO_MINIMA, 0);
    }

    public int maxBatchItems() {
        return prefs.getInt(CHAVE_LOTE_MAXIMO, LOTE_MAXIMO_PADRAO);
    }

    public int defaultPageSize() {
        return prefs.getInt(CHAVE_PAGINA_PADRAO, PAGINA_PADRAO);
    }

    public long updatedAt() {
        return prefs.getLong(CHAVE_ATUALIZADO_EM, 0L);
    }

    /** Busca a configuração. Faz rede; nunca chamar na thread principal. */
    public void refresh() {
        try {
            // Sem token: a configuração precisa estar acessível antes mesmo de
            // existir uma conta, porque é ela que diz se a conta faz sentido.
            ApiClient.Response response = api.get("/v1/config", null);

            JSONObject sync = response.body.optJSONObject("sync");
            if (sync == null) {
                return;
            }

            prefs.edit()
                    .putBoolean(CHAVE_SYNC_ATIVA, sync.optBoolean("enabled", false))
                    .putInt(CHAVE_PROTOCOLO_MINIMO, sync.optInt("minSupportedProtocolVersion", 1))
                    .putInt(CHAVE_VERSAO_MINIMA, sync.optInt("minAppVersionCode", 0))
                    .putInt(CHAVE_LOTE_MAXIMO, sync.optInt("maxBatchItems", LOTE_MAXIMO_PADRAO))
                    .putInt(CHAVE_PAGINA_PADRAO, sync.optInt("defaultPageSize", PAGINA_PADRAO))
                    .putLong(CHAVE_ATUALIZADO_EM, System.currentTimeMillis())
                    .apply();

        } catch (ApiException e) {
            // Falhar aqui é normal e não muda nada: continua valendo o último
            // valor conhecido.
            Log.d(TAG, "configuração remota indisponível: " + e.getMessage());
        }
    }
}
