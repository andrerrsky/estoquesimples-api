package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Gerenciador de status premium do usuário
 * Controla tanto a compra permanente quanto o modo premium temporário de 1 hora
 */
public class PremiumManager {
    
    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_IS_PRO = "isPro";
    private static final String KEY_TEMP_PREMIUM_EXPIRY = "tempPremiumExpiry";
    private static final long ONE_HOUR_IN_MILLIS = 60L * 60 * 1000; // 1 hora em milissegundos
    
    private SharedPreferences prefs;
    private final Context appContext;
    private static PremiumManager instance;
    
    private PremiumManager(Context context) {
        appContext = context.getApplicationContext();
        prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
    
    public static synchronized PremiumManager getInstance(Context context) {
        if (instance == null) {
            instance = new PremiumManager(context);
        }
        return instance;
    }
    
    /**
     * Define o usuário como PRO (compra permanente)
     */
    public void setPro(boolean isPro) {
        prefs.edit().putBoolean(KEY_IS_PRO, isPro).apply();
    }
    
    /**
     * Verifica se o usuário comprou a versão PRO
     */
    public boolean isPro() {
        return prefs.getBoolean(KEY_IS_PRO, false);
    }
    
    /**
     * Ativa o modo premium temporário por 1 hora
     */
    public void activateTempPremium() {
        long expiryTime = System.currentTimeMillis() + ONE_HOUR_IN_MILLIS;
        prefs.edit().putLong(KEY_TEMP_PREMIUM_EXPIRY, expiryTime).apply();
    }
    
    /**
     * Verifica se o modo premium temporário está ativo
     */
    public boolean isTempPremiumActive() {
        long expiryTime = prefs.getLong(KEY_TEMP_PREMIUM_EXPIRY, 0);
        if (expiryTime == 0) {
            return false;
        }
        
        long currentTime = System.currentTimeMillis();
        if (currentTime < expiryTime) {
            return true;
        } else {
            // Expirou, limpar
            clearTempPremium();
            return false;
        }
    }
    
    /**
     * Retorna o tempo restante do modo premium temporário em milissegundos
     * Retorna 0 se não estiver ativo
     */
    public long getTempPremiumRemainingTime() {
        if (!isTempPremiumActive()) {
            return 0;
        }
        long expiryTime = prefs.getLong(KEY_TEMP_PREMIUM_EXPIRY, 0);
        return expiryTime - System.currentTimeMillis();
    }
    
    /**
     * Limpa o modo premium temporário
     */
    public void clearTempPremium() {
        prefs.edit().remove(KEY_TEMP_PREMIUM_EXPIRY).apply();
    }
    
    /**
     * Verifica se o usuário tem acesso premium.
     *
     * Três origens independentes: a compra antiga e definitiva, a liberação
     * temporária por anúncio, e a assinatura da nuvem. Quem paga a assinatura
     * não deveria continuar vendo anúncios só porque nunca comprou a versão
     * antiga — e a compra antiga continua valendo para sempre, sem exigir conta.
     */
    public boolean hasPremiumAccess() {
        return isPro() || isTempPremiumActive() || hasCloudSubscription();
    }

    /**
     * Assinatura ativa validada pelo servidor.
     *
     * Lê apenas o retrato local, sem rede: este método é chamado a cada
     * exibição de anúncio e não pode bloquear a interface. O retrato tem prazo
     * de validade próprio, então uma assinatura cancelada deixa de valer mesmo
     * que o aparelho nunca mais se conecte.
     */
    public boolean hasCloudSubscription() {
        try {
            return new br.com.gameloop.estoquesimples.sync.EntitlementManager(appContext).canSync();
        } catch (Exception e) {
            return false;
        }
    }
    
    /**
     * Formata o tempo restante para exibição (ex: "45 min")
     */
    public String getFormattedRemainingTime() {
        long remainingMillis = getTempPremiumRemainingTime();
        if (remainingMillis <= 0) {
            return "";
        }
        
        long minutes = remainingMillis / (60 * 1000);
        if (minutes < 1) {
            return "menos de 1 min";
        } else if (minutes == 1) {
            return "1 minuto";
        } else {
            return minutes + " minutos";
        }
    }
}

