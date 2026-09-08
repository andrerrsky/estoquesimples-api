package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Direitos locais de premium (recursos da antiga Versão PRO e da assinatura).
 *
 * O app é livre e sem anúncios para todo mundo. Três estados independentes
 * decidem só o que fica de fora do uso local — a Análise de Estoque — e a
 * sincronização na nuvem:
 * <ul>
 *   <li>gratuito — tudo local liberado; Análise de Estoque e nuvem bloqueadas;</li>
 *   <li>compra única antiga ({@code isPro}) — Análise de Estoque liberada para
 *       sempre, sem sincronização em nuvem;</li>
 *   <li>assinatura ativa ({@code hasCloudSubscription}) — Análise de Estoque e
 *       sincronização em nuvem.</li>
 * </ul>
 * Quem tem os dois acumula os benefícios. Cancelar a assinatura tira só a nuvem.
 */
public class PremiumManager {

    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_IS_PRO = "isPro";
    /** Chave do desbloqueio temporário por anúncio, removido da oferta. */
    private static final String KEY_TEMP_PREMIUM_EXPIRY = "tempPremiumExpiry";

    private SharedPreferences prefs;
    private final Context appContext;
    private static PremiumManager instance;

    private PremiumManager(Context context) {
        appContext = context.getApplicationContext();
        prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // A oferta de 1 hora por vídeo saiu do app. Limpa qualquer prazo antigo
        // para ninguém continuar premium só porque assistiu um anúncio.
        if (prefs.contains(KEY_TEMP_PREMIUM_EXPIRY)) {
            prefs.edit().remove(KEY_TEMP_PREMIUM_EXPIRY).apply();
        }
    }

    public static synchronized PremiumManager getInstance(Context context) {
        if (instance == null) {
            instance = new PremiumManager(context);
        }
        return instance;
    }

    /**
     * Marca o usuário como comprador da antiga Versão PRO.
     *
     * Só deve ser chamado após consulta à Play Store. Não existe mais fluxo
     * de compra deste produto no aplicativo.
     */
    public void setPro(boolean isPro) {
        prefs.edit().putBoolean(KEY_IS_PRO, isPro).apply();
    }

    /**
     * Compra única antiga reconhecida neste aparelho.
     */
    public boolean isPro() {
        return prefs.getBoolean(KEY_IS_PRO, false);
    }

    /**
     * Acesso aos recursos premium (hoje, a Análise de Estoque).
     *
     * Vale para a compra antiga e para a assinatura. Não libera sincronização.
     */
    public boolean hasPremiumAccess() {
        return isPro() || hasCloudSubscription();
    }

    /**
     * Assinatura ativa validada pelo servidor.
     *
     * Lê apenas o retrato local, sem rede: este método é chamado a cada
     * abertura/retomada de tela que depende do status premium e não pode
     * bloquear a interface. O retrato tem prazo de validade próprio, então uma
     * assinatura cancelada deixa de valer mesmo que o aparelho nunca mais se
     * conecte.
     */
    public boolean hasCloudSubscription() {
        try {
            return new br.com.gameloop.estoquesimples.sync.EntitlementManager(appContext).canSync();
        } catch (Exception e) {
            return false;
        }
    }
}
