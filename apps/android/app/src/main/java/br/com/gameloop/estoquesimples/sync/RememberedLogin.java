package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * E-mail e senha que o login pode preencher de novo.
 *
 * Arquivo separado da sessão: sair da conta limpa o token, não estas
 * credenciais. Sem o Keystore disponível, nada é gravado em texto claro.
 */
public final class RememberedLogin {

    private static final String TAG = "RememberedLogin";
    private static final String ARQUIVO = "estoque_login_lembrado";
    private static final String CHAVE_EMAIL = "email";
    private static final String CHAVE_SENHA = "senha";

    private RememberedLogin() {}

    public static boolean hasSaved(Context context) {
        SharedPreferences prefs = open(context);
        if (prefs == null) {
            return false;
        }
        String email = prefs.getString(CHAVE_EMAIL, "");
        String senha = prefs.getString(CHAVE_SENHA, "");
        return email != null && !email.isEmpty() && senha != null && !senha.isEmpty();
    }

    public static String email(Context context) {
        SharedPreferences prefs = open(context);
        return prefs == null ? "" : prefs.getString(CHAVE_EMAIL, "");
    }

    public static String password(Context context) {
        SharedPreferences prefs = open(context);
        return prefs == null ? "" : prefs.getString(CHAVE_SENHA, "");
    }

    public static void save(Context context, String email, String senha) {
        SharedPreferences prefs = open(context);
        if (prefs == null) {
            return;
        }
        prefs.edit()
                .putString(CHAVE_EMAIL, email == null ? "" : email)
                .putString(CHAVE_SENHA, senha == null ? "" : senha)
                .apply();
    }

    public static void clear(Context context) {
        SharedPreferences prefs = open(context);
        if (prefs == null) {
            return;
        }
        prefs.edit().clear().apply();
    }

    private static SharedPreferences open(Context context) {
        try {
            MasterKey key = new MasterKey.Builder(context.getApplicationContext())
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            return EncryptedSharedPreferences.create(
                    context.getApplicationContext(),
                    ARQUIVO,
                    key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Exception e) {
            Log.e(TAG, "falha ao abrir o armazenamento do login lembrado", e);
            return null;
        }
    }
}
