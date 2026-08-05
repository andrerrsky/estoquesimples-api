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
 * O ponto delicado é o que fazer sem rede. Exigir confirmação online a cada uso
 * transformaria uma queda de internet em perda de acesso pago; confiar no
 * último retrato para sempre transformaria um cancelamento em acesso vitalício.
 * O meio-termo é o {@code offlineValidUntil} que a API devolve: o retrato vale
 * até aquela data e depois disso a sincronização para — <b>sem</b> apagar ou
 * bloquear nada do que já está no aparelho.
 */
public final class EntitlementManager {

    private static final String TAG = "EntitlementManager";

    private static final String ARQUIVO = "estoque_direitos";
    private static final String CHAVE_ATIVO = "ativo";
    private static final String CHAVE_PLANO = "plano";
    private static final String CHAVE_ESTADO = "estado";
    private static final String CHAVE_VALIDO_ATE = "valido_offline_ate";
    private static final String CHAVE_VERIFICADO_EM = "verificado_em";
    private static final String CHAVE_FIM_PERIODO = "fim_periodo";
    private static final String CHAVE_CARENCIA_ATE = "carencia_ate";
    private static final String CHAVE_AUTO_RENOVANDO = "auto_renovando";

    private final SharedPreferences prefs;
    private final ApiClient api;
    private final SessionManager session;

    public EntitlementManager(Context context) {
        // Direitos não são segredo: são um retrato do que o servidor já sabe, e
        // adulterá-los localmente não concede nada, porque o servidor recusa a
        // sincronização de quem não tem assinatura ativa.
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
        this.api = new ApiClient();
        this.session = SessionManager.get(context);
    }

    /**
     * A empresa pode sincronizar agora.
     *
     * Combina o estado informado pelo servidor com a validade do retrato: um
     * direito ativo cujo retrato venceu não vale, porque pode ter sido
     * cancelado enquanto o aparelho estava sem rede.
     */
    public boolean canSync() {
        return prefs.getBoolean(CHAVE_ATIVO, false)
                && System.currentTimeMillis() < prefs.getLong(CHAVE_VALIDO_ATE, 0L);
    }

    /** Retrato existe mas venceu: dá para explicar melhor do que "sem acesso". */
    public boolean isStale() {
        return prefs.contains(CHAVE_ATIVO)
                && System.currentTimeMillis() >= prefs.getLong(CHAVE_VALIDO_ATE, 0L);
    }

    public String planKey() {
        return prefs.getString(CHAVE_PLANO, null);
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

    public boolean autoRenewing() {
        return prefs.getBoolean(CHAVE_AUTO_RENOVANDO, false);
    }

    /**
     * Texto legível do estado atual para a tela de assinatura.
     *
     * Perder a assinatura nunca apaga nem bloqueia dados locais — só para de
     * sincronizar. Essa regra aparece em toda mensagem relevante.
     */
    public String stateLegivel() {
        String estado = state();
        if (estado == null || estado.isEmpty()) {
            return "Sem assinatura. O app funciona normalmente neste aparelho; "
                    + "a nuvem exige assinatura.";
        }
        switch (estado) {
            case "sem_assinatura":
                return "Sem assinatura. O app funciona normalmente neste aparelho; "
                        + "a nuvem exige assinatura.";
            case "pendente":
                return "Pagamento em processamento. Assim que o Google confirmar, "
                        + "a sincronização liga sozinha.";
            case "ativa":
                return "Ativa. Renova em " + formatDate(currentPeriodEnd()) + ".";
            case "carencia":
                return "Houve um problema no pagamento. Você continua sincronizando até "
                        + formatDate(graceUntil())
                        + "; atualize a forma de pagamento no Google Play.";
            case "cancelada_mas_ativa":
                return "Renovação desligada. Você sincroniza até "
                        + formatDate(currentPeriodEnd()) + ".";
            case "suspensa":
                return "Assinatura suspensa por falta de pagamento. "
                        + "Os dados continuam neste aparelho.";
            case "expirada":
                return "Assinatura encerrada. Nada foi apagado deste aparelho.";
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
     * um round-trip extra e liga a sincronização assim que a compra confirma.
     */
    public void apply(JSONObject body) {
        if (body == null) {
            return;
        }
        store(body);
    }

    private void store(JSONObject body) {
        prefs.edit()
                .putBoolean(CHAVE_ATIVO, body.optBoolean("active", false))
                .putString(CHAVE_PLANO, body.optString("planKey", null))
                .putString(CHAVE_ESTADO, body.optString("state", null))
                .putLong(CHAVE_VALIDO_ATE, parseIso(body.optString("offlineValidUntil", null)))
                .putLong(CHAVE_VERIFICADO_EM, parseIso(body.optString("checkedAt", null)))
                .putLong(CHAVE_FIM_PERIODO, parseIso(body.optString("currentPeriodEnd", null)))
                .putLong(CHAVE_CARENCIA_ATE, parseIso(body.optString("graceUntil", null)))
                .putBoolean(CHAVE_AUTO_RENOVANDO, body.optBoolean("autoRenewing", false))
                .apply();
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
