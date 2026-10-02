package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Direitos da empresa segundo o servidor.
 *
 * Desde o plano gratuito com nuvem, o retrato responde a três perguntas
 * diferentes: a empresa pode sincronizar ({@link #canSync}), a assinatura
 * paga está valendo ({@link #isPaid}, que libera equipe e Análise Avançada)
 * e quanto do teto de produtos já foi usado ({@link #productLimit},
 * {@link #productsUsed}).
 *
 * O ponto delicado é o que fazer sem rede. Exigir confirmação online a cada uso
 * transformaria uma queda de internet em perda de acesso; confiar no último
 * retrato para sempre transformaria um cancelamento em acesso vitalício. O
 * meio-termo é o {@code offlineValidUntil} que a API devolve: o retrato vale
 * até aquela data e depois disso a sincronização para — <b>sem</b> apagar ou
 * bloquear nada do que já está no aparelho.
 */
public final class EntitlementManager {

    private static final String TAG = "EntitlementManager";

    private static final String ARQUIVO = "estoque_direitos";
    private static final String CHAVE_ATIVO = "ativo";
    private static final String CHAVE_SYNC = "sync_permitido";
    private static final String CHAVE_EQUIPE = "equipe_liberada";
    private static final String CHAVE_ANALISE = "analise_liberada";
    private static final String CHAVE_LIMITE_PRODUTOS = "limite_produtos";
    private static final String CHAVE_USO_PRODUTOS = "uso_produtos";
    private static final String CHAVE_LIMITE_MEMBROS = "limite_membros";
    private static final String CHAVE_USO_MEMBROS = "uso_membros";
    private static final String CHAVE_PLANO = "plano";
    private static final String CHAVE_ESTADO = "estado";
    private static final String CHAVE_VALIDO_ATE = "valido_offline_ate";
    private static final String CHAVE_VERIFICADO_EM = "verificado_em";
    private static final String CHAVE_FIM_PERIODO = "fim_periodo";
    private static final String CHAVE_CARENCIA_ATE = "carencia_ate";
    private static final String CHAVE_AUTO_RENOVANDO = "auto_renovando";
    private static final String CHAVE_PROVEDOR = "provedor";

    /** Valor guardado quando o plano não limita. */
    public static final int SEM_LIMITE = -1;

    private final SharedPreferences prefs;
    private final ApiClient api;
    private final SessionManager session;

    public EntitlementManager(Context context) {
        // Direitos não são segredo: são um retrato do que o servidor já sabe, e
        // adulterá-los localmente não concede nada, porque o servidor confere o
        // plano em toda sincronização e em todo convite.
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
        this.api = new ApiClient();
        this.session = SessionManager.get(context);
    }

    private boolean retratoValido() {
        return System.currentTimeMillis() < prefs.getLong(CHAVE_VALIDO_ATE, 0L);
    }

    /**
     * A empresa pode sincronizar agora (plano gratuito incluído).
     *
     * Combina o que o servidor disse com a validade do retrato: um direito
     * cujo retrato venceu não vale, porque pode ter mudado enquanto o aparelho
     * estava sem rede.
     */
    public boolean canSync() {
        return prefs.getBoolean(CHAVE_SYNC, false) && retratoValido();
    }

    /** Assinatura paga valendo: libera equipe, produtos sem teto e Análise Avançada. */
    public boolean isPaid() {
        return prefs.getBoolean(CHAVE_ATIVO, false) && retratoValido();
    }

    /** A empresa pode ter equipe (convidar e sincronizar com mais de uma pessoa). */
    public boolean teamEnabled() {
        return prefs.getBoolean(CHAVE_EQUIPE, false) && retratoValido();
    }

    /** Análise Avançada liberada pelo plano (a Versão PRO antiga é outro caminho). */
    public boolean analysisEnabled() {
        return prefs.getBoolean(CHAVE_ANALISE, false) && retratoValido();
    }

    /** Teto de produtos na nuvem, ou {@link #SEM_LIMITE}. */
    public int productLimit() {
        return prefs.getInt(CHAVE_LIMITE_PRODUTOS, SEM_LIMITE);
    }

    /** Produtos vivos na nuvem na última consulta. */
    public int productsUsed() {
        return prefs.getInt(CHAVE_USO_PRODUTOS, 0);
    }

    public int memberLimit() {
        return prefs.getInt(CHAVE_LIMITE_MEMBROS, SEM_LIMITE);
    }

    public int membersUsed() {
        return prefs.getInt(CHAVE_USO_MEMBROS, 0);
    }

    /** Já existe um retrato guardado (a empresa foi consultada ao menos uma vez). */
    public boolean hasSnapshot() {
        return prefs.contains(CHAVE_SYNC);
    }

    /** Retrato existe mas venceu: dá para explicar melhor do que "sem acesso". */
    public boolean isStale() {
        return prefs.contains(CHAVE_SYNC) && !retratoValido();
    }

    public String planKey() {
        return prefs.getString(CHAVE_PLANO, null);
    }

    /** Nome do plano para a interface. */
    public String planLegivel() {
        return isPaid() ? "Plano Equipe" : "Plano gratuito";
    }

    public String state() {
        return prefs.getString(CHAVE_ESTADO, null);
    }

    public long checkedAt() {
        return prefs.getLong(CHAVE_VERIFICADO_EM, 0L);
    }

    public long currentPeriodEnd() {
        return prefs.getLong(CHAVE_FIM_PERIODO, 0L);
    }

    public long graceUntil() {
        return prefs.getLong(CHAVE_CARENCIA_ATE, 0L);
    }

    /**
     * A assinatura em vigor foi contratada pela versão web (cobrada pelo
     * Asaas), e não pela Google Play. Para o direito de uso não muda nada;
     * só muda onde ela é gerenciada. APIs antigas não mandam o provedor: aí
     * vale o comportamento de sempre (Google Play).
     */
    public boolean managedOnWeb() {
        return isPaid() && "asaas".equals(prefs.getString(CHAVE_PROVEDOR, null));
    }

    public boolean autoRenewing() {
        return prefs.getBoolean(CHAVE_AUTO_RENOVANDO, false);
    }

    /**
     * Texto legível da assinatura para as telas de conta e de assinatura.
     *
     * Perder a assinatura nunca apaga nem bloqueia dados locais: a empresa
     * volta ao plano gratuito, que continua sincronizando para o proprietário.
     */
    public String stateLegivel() {
        String estado = state();
        if (estado == null || estado.isEmpty() || "sem_assinatura".equals(estado)) {
            return "Plano gratuito: nuvem para você, em todos os seus aparelhos"
                    + (productLimit() == SEM_LIMITE ? "." : ", com até " + productLimit() + " produtos.");
        }
        switch (estado) {
            case "pendente":
                return "Pagamento em processamento. Assim que o Google confirmar, "
                        + "o plano Equipe liga sozinho.";
            case "ativa":
                return "Plano Equipe ativo. Renova em " + formatDate(currentPeriodEnd()) + ".";
            case "carencia":
                return "Houve um problema no pagamento. O plano Equipe continua até "
                        + formatDate(graceUntil())
                        + "; atualize a forma de pagamento no Google Play.";
            case "cancelada_mas_ativa":
                return "Renovação desligada. O plano Equipe vale até "
                        + formatDate(currentPeriodEnd()) + "; depois a empresa volta ao plano gratuito.";
            case "suspensa":
                return "Assinatura suspensa por falta de pagamento. A empresa está no plano "
                        + "gratuito até o pagamento regularizar; nada foi apagado.";
            case "expirada":
                return "Assinatura encerrada. A empresa voltou ao plano gratuito; "
                        + "nada foi apagado deste aparelho.";
            default:
                return "Assinatura: " + estado
                        + ". Os dados locais nunca são apagados por falta de assinatura.";
        }
    }

    /** Busca o estado atual. Faz rede; nunca chamar na thread principal. */
    public boolean refresh() throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            return false;
        }

        ApiClient.Response response = api.get(
                "/v1/workspaces/" + workspaceId + "/entitlement", session.accessToken());
        store(response.body);
        return canSync();
    }

    /**
     * Grava o entitlement devolvido pela API (GET ou POST de vinculação).
     *
     * O POST de vinculação devolve o mesmo objeto do GET: aplicar aqui evita
     * um round-trip extra e liga a equipe assim que a compra confirma.
     */
    public void apply(JSONObject body) {
        if (body == null) {
            return;
        }
        store(body);
    }

    private void store(JSONObject body) {
        JSONObject features = body.optJSONObject("features");
        JSONObject limits = body.optJSONObject("limits");
        JSONObject usage = body.optJSONObject("usage");
        boolean ativo = body.optBoolean("active", false);
        // APIs antigas não mandam syncAllowed: nelas, nuvem = assinatura.
        boolean sync = body.has("syncAllowed")
                ? body.optBoolean("syncAllowed", false)
                : ativo;
        prefs.edit()
                .putBoolean(CHAVE_ATIVO, ativo)
                .putBoolean(CHAVE_SYNC, sync)
                .putBoolean(CHAVE_EQUIPE, featureEnabled(features, "equipe.membros", ativo))
                .putBoolean(CHAVE_ANALISE, featureEnabled(features, "analise.avancada", ativo))
                .putInt(CHAVE_LIMITE_PRODUTOS, limitOf(limits, "products"))
                .putInt(CHAVE_USO_PRODUTOS, usage == null ? 0 : usage.optInt("products", 0))
                .putInt(CHAVE_LIMITE_MEMBROS, limitOf(limits, "members"))
                .putInt(CHAVE_USO_MEMBROS, usage == null ? 0 : usage.optInt("members", 0))
                .putString(CHAVE_PLANO, body.optString("planKey", null))
                .putString(CHAVE_ESTADO, body.optString("state", null))
                .putLong(CHAVE_VALIDO_ATE, parseIso(body.optString("offlineValidUntil", null)))
                .putLong(CHAVE_VERIFICADO_EM, parseIso(body.optString("checkedAt", null)))
                .putLong(CHAVE_FIM_PERIODO, parseIso(body.optString("currentPeriodEnd", null)))
                .putLong(CHAVE_CARENCIA_ATE, parseIso(body.optString("graceUntil", null)))
                .putBoolean(CHAVE_AUTO_RENOVANDO, body.optBoolean("autoRenewing", false))
                // isNull antes: optString devolveria o texto "null".
                .putString(CHAVE_PROVEDOR, body.isNull("provider") ? null : body.optString("provider", null))
                .apply();
    }

    private static boolean featureEnabled(JSONObject features, String key, boolean fallback) {
        if (features == null) {
            return fallback;
        }
        JSONObject feature = features.optJSONObject(key);
        return feature == null ? fallback : feature.optBoolean("enabled", false);
    }

    private static int limitOf(JSONObject limits, String key) {
        if (limits == null || limits.isNull(key)) {
            return SEM_LIMITE;
        }
        return limits.optInt(key, SEM_LIMITE);
    }

    /** Esquece o retrato ao sair da conta ou trocar de empresa. */
    public void clear() {
        prefs.edit().clear().apply();
    }

    private static String formatDate(long millis) {
        if (millis <= 0L) {
            return "data a confirmar";
        }
        return new SimpleDateFormat("dd/MM/yyyy", Locale.getDefault())
                .format(new Date(millis));
    }

    private static long parseIso(String value) {
        if (value == null || value.isEmpty() || "null".equals(value)) {
            return 0L;
        }
        // A API devolve ISO-8601 em UTC. Sem fixar o fuso, o mesmo texto seria
        // interpretado de formas diferentes conforme o ajuste do aparelho.
        SimpleDateFormat[] formatos = {
                new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US),
                new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US),
        };
        for (SimpleDateFormat formato : formatos) {
            formato.setTimeZone(TimeZone.getTimeZone("UTC"));
            try {
                return formato.parse(value).getTime();
            } catch (ParseException ignored) {
                // Tenta o próximo formato.
            }
        }
        Log.w(TAG, "data em formato inesperado: " + value);
        return 0L;
    }
}
