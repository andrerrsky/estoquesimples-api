package br.com.gameloop.estoquesimples.billing;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Comprovante de assinatura ainda não confirmado pelo servidor.
 *
 * O token sozinho não concede nada: o servidor sempre revalida no Google.
 * Persistimos a pendência para que um fechamento do app entre a compra e a
 * vinculação não cause estorno automático em três dias.
 */
public final class PendingPurchase {

    private static final String ARQUIVO = "estoque_assinatura";
    private static final String CHAVE_TOKEN = "token_pendente";
    private static final String CHAVE_TENTATIVAS = "tentativas";
    private static final String CHAVE_ULTIMO_ERRO = "ultimo_erro";
    private static final String CHAVE_ERRO_PERMANENTE = "erro_permanente";

    private final SharedPreferences prefs;

    public PendingPurchase(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
    }

    public void save(String purchaseToken) {
        if (purchaseToken == null || purchaseToken.isEmpty()) {
            return;
        }
        prefs.edit()
                .putString(CHAVE_TOKEN, purchaseToken)
                .putInt(CHAVE_TENTATIVAS, 0)
                .putString(CHAVE_ULTIMO_ERRO, null)
                .putBoolean(CHAVE_ERRO_PERMANENTE, false)
                .apply();
    }

    public String token() {
        return prefs.getString(CHAVE_TOKEN, null);
    }

    public boolean hasToken() {
        String token = token();
        return token != null && !token.isEmpty();
    }

    public int attempts() {
        return prefs.getInt(CHAVE_TENTATIVAS, 0);
    }

    public String lastError() {
        return prefs.getString(CHAVE_ULTIMO_ERRO, null);
    }

    public boolean isPermanentError() {
        return prefs.getBoolean(CHAVE_ERRO_PERMANENTE, false);
    }

    public void recordTransientError(String message) {
        prefs.edit()
                .putInt(CHAVE_TENTATIVAS, attempts() + 1)
                .putString(CHAVE_ULTIMO_ERRO, message)
                .putBoolean(CHAVE_ERRO_PERMANENTE, false)
                .apply();
    }

    public void recordPermanentError(String message) {
        prefs.edit()
                .putInt(CHAVE_TENTATIVAS, attempts() + 1)
                .putString(CHAVE_ULTIMO_ERRO, message)
                .putBoolean(CHAVE_ERRO_PERMANENTE, true)
                .apply();
    }

    public void clear() {
        prefs.edit().clear().apply();
    }
}
