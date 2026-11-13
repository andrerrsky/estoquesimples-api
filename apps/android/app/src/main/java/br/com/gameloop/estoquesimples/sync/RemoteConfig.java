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
    private static final String CHAVE_VERSAO_OBRIGATORIA = "versao_obrigatoria";
    private static final String CHAVE_VERSAO_MAIS_NOVA = "versao_mais_nova";
    private static final String CHAVE_URL_ATUALIZACAO = "url_atualizacao";
    private static final String CHAVE_RECADO_ATUALIZACAO = "recado_atualizacao";
    private static final String CHAVE_BLOQUEIOS_VISTOS = "bloqueios_vistos";
    private static final String CHAVE_TREGUA_EM = "tregua_em";

    private static final String URL_PLAY_PADRAO =
            "https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples";

    /** Depois de tantas telas de bloqueio, aparece a saída de emergência. */
    public static final int BLOQUEIOS_ATE_A_SAIDA = 3;

    /** Quanto tempo a saída de emergência vale. */
    static final long TREGUA_MS = 24L * 3_600_000L;

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

    /**
     * Esta versão do app ainda pode ser usada?
     *
     * Diferente de {@link #isProtocolSupported()}, que só pausa a nuvem: aqui
     * o aplicativo inteiro para, e por isso o padrão é <b>zero</b> — sem uma
     * resposta explícita do servidor, ninguém é bloqueado. Um app
     * offline-first não pode ficar inútil porque a API está fora do ar.
     */
    public boolean isUpdateRequired() {
        return BuildConfig.VERSION_CODE < prefs.getInt(CHAVE_VERSAO_OBRIGATORIA, 0);
    }

    /**
     * O bloqueio vale agora? É o que as telas devem perguntar.
     *
     * Difere de {@link #isUpdateRequired()} por respeitar a trégua: quem não
     * consegue atualizar — loja sem conta, aparelho antigo, armazenamento
     * cheio — não pode perder o acesso ao próprio estoque, que está neste
     * aparelho e é dele. A trégua dura um dia e precisa ser pedida de novo.
     */
    public boolean isUpdateBlocking() {
        return isUpdateRequired() && !emTregua();
    }

    /**
     * Registra mais uma tela de bloqueio e diz se já cabe oferecer a saída.
     *
     * A saída não aparece de primeira de propósito: a esmagadora maioria das
     * pessoas simplesmente atualiza, e um botão de escapar logo na primeira
     * tela esvaziaria o bloqueio — que existe para tirar de circulação uma
     * versão que estraga dados.
     */
    public boolean registerBlockShown() {
        int vistos = prefs.getInt(CHAVE_BLOQUEIOS_VISTOS, 0) + 1;
        prefs.edit().putInt(CHAVE_BLOQUEIOS_VISTOS, vistos).apply();
        return vistos >= BLOQUEIOS_ATE_A_SAIDA;
    }

    /** Quantas telas de bloqueio este aparelho já viu desde a última trégua. */
    public int blockShownCount() {
        return prefs.getInt(CHAVE_BLOQUEIOS_VISTOS, 0);
    }

    /** Libera o app por {@link #TREGUA_MS}. */
    public void grantGrace() {
        prefs.edit()
                .putLong(CHAVE_TREGUA_EM, System.currentTimeMillis())
                .putInt(CHAVE_BLOQUEIOS_VISTOS, 0)
                .apply();
    }

    /**
     * A trégua é medida do instante em que foi concedida, e um relógio
     * adiantado e depois corrigido a encerra na hora: guardar a data de
     * validade deixaria o bloqueio desligado por anos num aparelho com a data
     * errada.
     */
    private boolean emTregua() {
        return emTregua(prefs.getLong(CHAVE_TREGUA_EM, 0L), System.currentTimeMillis());
    }

    static boolean emTregua(long concedida, long agora) {
        if (concedida <= 0L) {
            return false;
        }
        return agora >= concedida && agora - concedida < TREGUA_MS;
    }

    public String updateUrl() {
        return prefs.getString(CHAVE_URL_ATUALIZACAO, URL_PLAY_PADRAO);
    }

    /** Recado do servidor para a tela de atualização, ou {@code null}. */
    public String updateMessage() {
        String recado = prefs.getString(CHAVE_RECADO_ATUALIZACAO, null);
        return recado == null || recado.trim().isEmpty() ? null : recado.trim();
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

            // Bloco opcional: uma versão do servidor que ainda não o envie não
            // pode ressuscitar um bloqueio antigo nem apagar o que já se sabe.
            JSONObject app = response.body.optJSONObject("app");
            if (app != null) {
                prefs.edit()
                        .putInt(CHAVE_VERSAO_OBRIGATORIA, app.optInt("minRequiredVersionCode", 0))
                        .putInt(CHAVE_VERSAO_MAIS_NOVA, app.optInt("latestVersionCode", 0))
                        .putString(CHAVE_URL_ATUALIZACAO, app.optString("updateUrl", URL_PLAY_PADRAO))
                        .putString(CHAVE_RECADO_ATUALIZACAO, app.isNull("message") ? null : app.optString("message", null))
                        .apply();
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
