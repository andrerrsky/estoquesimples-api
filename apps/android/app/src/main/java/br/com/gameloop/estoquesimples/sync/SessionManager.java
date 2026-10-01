package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONObject;

import java.util.UUID;

/**
 * Credenciais da conta e renovação do acesso.
 *
 * Os tokens ficam em {@link EncryptedSharedPreferences} porque o app tem
 * {@code allowBackup="true"}: em preferências comuns, o refresh token sairia do
 * aparelho no backup automático do Android e valeria por semanas na mão de quem
 * o obtivesse. Criptografado com uma chave do Keystore, o arquivo restaurado em
 * outro aparelho é ilegível.
 */
public final class SessionManager {

    private static final String TAG = "SessionManager";

    private static final String ARQUIVO = "estoque_sessao";
    private static final String CHAVE_ACCESS = "access_token";
    private static final String CHAVE_ACCESS_EXPIRA = "access_expira_em";
    private static final String CHAVE_REFRESH = "refresh_token";
    private static final String CHAVE_USUARIO_ID = "usuario_id";
    private static final String CHAVE_USUARIO_EMAIL = "usuario_email";
    private static final String CHAVE_USUARIO_NOME = "usuario_nome";
    private static final String CHAVE_USUARIO_EMAIL_VERIFICADO = "usuario_email_verificado";
    private static final String CHAVE_WORKSPACE_ID = "workspace_id";
    private static final String CHAVE_WORKSPACE_NOME = "workspace_nome";
    private static final String CHAVE_PAPEL = "papel";
    private static final String CHAVE_DISPOSITIVO_ID = "dispositivo_id";

    /**
     * Renova o acesso um pouco antes de ele vencer. Sem essa folga, uma
     * requisição iniciada com o token quase vencido chega ao servidor já
     * expirada e falha por um motivo que não é do usuário.
     */
    private static final long FOLGA_RENOVACAO_MS = 60_000L;

    private static SessionManager instance;

    private final SharedPreferences prefs;
    private final ApiClient api;

    /** Guarda a sessão quando não foi possível abrir o arquivo criptografado. */
    private final MemorySession fallback = new MemorySession();
    private final boolean usingFallback;

    private SessionManager(Context context, ApiClient api) {
        this.api = api;

        SharedPreferences opened = openEncrypted(context);
        if (opened == null) {
            // Segunda tentativa: o arquivo pode ter ficado ilegível se a chave
            // do Keystore foi invalidada (troca de bloqueio de tela, restauração
            // de backup). Apagar e recriar custa um novo login, o que é bem
            // melhor do que a sincronização parar de funcionar para sempre.
            context.deleteSharedPreferences(ARQUIVO);
            opened = openEncrypted(context);
        }

        this.prefs = opened;
        this.usingFallback = opened == null;
        if (usingFallback) {
            // Nunca cair para preferências em texto claro: o refresh token vale
            // por semanas. Sem armazenamento seguro, a sessão dura só enquanto
            // o app estiver aberto.
            Log.e(TAG, "armazenamento seguro indisponível; sessão apenas em memória");
        }
    }

    public static synchronized SessionManager get(Context context) {
        if (instance == null) {
            instance = new SessionManager(context.getApplicationContext(), new ApiClient());
        }
        return instance;
    }

    private static SharedPreferences openEncrypted(Context context) {
        try {
            MasterKey key = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            return EncryptedSharedPreferences.create(
                    context,
                    ARQUIVO,
                    key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Exception e) {
            Log.e(TAG, "falha ao abrir o armazenamento seguro", e);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Estado
    // -------------------------------------------------------------------------

    public boolean isSignedIn() {
        return refreshToken() != null;
    }

    public String userEmail() {
        return read(CHAVE_USUARIO_EMAIL);
    }

    public String userName() {
        return read(CHAVE_USUARIO_NOME);
    }

    /**
     * Se o e-mail desta conta já foi confirmado.
     *
     * Vale o que o servidor devolveu no último login, cadastro ou
     * {@code GET /v1/me}. Sem essa informação o app não assume nada — o
     * convite continua falando com o servidor.
     */
    public boolean isEmailVerified() {
        return "1".equals(read(CHAVE_USUARIO_EMAIL_VERIFICADO));
    }

    /** O servidor já disse que este endereço ainda não foi confirmado. */
    public boolean needsEmailVerification() {
        return "0".equals(read(CHAVE_USUARIO_EMAIL_VERIFICADO));
    }

    public synchronized void setEmailVerified(boolean verified) {
        write(CHAVE_USUARIO_EMAIL_VERIFICADO, verified ? "1" : "0");
    }

    public String workspaceId() {
        return read(CHAVE_WORKSPACE_ID);
    }

    public String workspaceName() {
        return read(CHAVE_WORKSPACE_NOME);
    }

    public String role() {
        return read(CHAVE_PAPEL);
    }

    /**
     * Identificador deste aparelho, criado na primeira vez que é pedido.
     *
     * Serve para o usuário reconhecer e encerrar sessões na tela de conta, e
     * para o servidor distinguir dois aparelhos da mesma pessoa durante a
     * sincronização.
     */
    public synchronized String deviceId() {
        String id = read(CHAVE_DISPOSITIVO_ID);
        if (id == null) {
            id = UUID.randomUUID().toString();
            write(CHAVE_DISPOSITIVO_ID, id);
        }
        return id;
    }

    // -------------------------------------------------------------------------
    // Acesso
    // -------------------------------------------------------------------------

    /**
     * Token válido para a próxima chamada, renovando-o se necessário.
     *
     * É {@code synchronized} porque o worker de sincronização e a interface
     * podem pedir acesso ao mesmo tempo. Duas renovações simultâneas com o
     * mesmo refresh token fazem o servidor tratar a segunda como reutilização
     * — que é sinal de token roubado — e derrubar a sessão inteira.
     */
    public synchronized String accessToken() throws ApiException {
        String current = read(CHAVE_ACCESS);
        long expiresAt = readLong(CHAVE_ACCESS_EXPIRA);

        if (current != null && System.currentTimeMillis() + FOLGA_RENOVACAO_MS < expiresAt) {
            return current;
        }

        String refresh = refreshToken();
        if (refresh == null) {
            throw new ApiException(401, ApiException.NAO_AUTENTICADO,
                    "Entre na sua conta para sincronizar.", null);
        }

        try {
            // O corpo aceita apenas o refresh token: a API valida com `strict`
            // e recusa qualquer campo extra.
            JSONObject body = new JSONObject();
            body.put("refreshToken", refresh);

            ApiClient.Response response = api.post("/v1/auth/refresh", body, null);
            storeTokens(response.body);
            return read(CHAVE_ACCESS);

        } catch (ApiException e) {
            // Refresh recusado significa sessão encerrada do outro lado: manter
            // as credenciais só faria cada tentativa seguinte falhar igual.
            if (e.needsReauth()) {
                signOutLocally();
            }
            throw e;
        } catch (Exception e) {
            throw ApiException.network(e);
        }
    }

    private String refreshToken() {
        return read(CHAVE_REFRESH);
    }

    /**
     * Descarta o token de acesso mantendo a sessão.
     *
     * Usado quando o papel do usuário muda: o token continua assinado e no
     * prazo, mas descreve permissões que não valem mais. A próxima chamada
     * troca-o pelo refresh token, sem exigir login de novo.
     */
    public synchronized void invalidateAccessToken() {
        write(CHAVE_ACCESS_EXPIRA, 0L);
    }

    // -------------------------------------------------------------------------
    // Entrada e saída
    // -------------------------------------------------------------------------

    public synchronized void storeSession(JSONObject payload) {
        storeTokens(payload);

        JSONObject user = payload.optJSONObject("user");
        if (user != null) {
            storeUser(user);
        }

    }

    /**
     * Atualiza o perfil a partir de {@code GET /v1/me} ou do objeto {@code user}
     * da autenticação.
     */
    public synchronized void storeUser(JSONObject user) {
        write(CHAVE_USUARIO_ID, user.optString("id", null));
        write(CHAVE_USUARIO_EMAIL, user.optString("email", null));
        write(CHAVE_USUARIO_NOME, user.optString("name", null));
        if (user.has("emailVerified")) {
            setEmailVerified(user.optBoolean("emailVerified", false));
        }
    }

    /**
     * Registra qual empresa este aparelho sincroniza.
     *
     * Vem separado do login porque a resposta de autenticação não traz empresa
     * alguma: o usuário pode participar de várias, ou de nenhuma logo após se
     * cadastrar. A escolha é um passo próprio.
     */
    public synchronized void storeWorkspace(String id, String name, String role) {
        write(CHAVE_WORKSPACE_ID, id);
        write(CHAVE_WORKSPACE_NOME, name);
        write(CHAVE_PAPEL, role);
    }

    private void storeTokens(JSONObject payload) {
        String access = payload.optString("accessToken", null);
        String refresh = payload.optString("refreshToken", null);
        long expiresIn = payload.optLong("expiresIn", 0L);

        if (access != null) {
            write(CHAVE_ACCESS, access);
            write(CHAVE_ACCESS_EXPIRA, System.currentTimeMillis() + expiresIn * 1000L);
        }
        if (refresh != null) {
            write(CHAVE_REFRESH, refresh);
        }
    }

    /**
     * Encerra a sessão neste aparelho.
     *
     * Nenhum produto ou movimentação é apagado. Sair da conta devolve o app ao
     * modo em que ele sempre funcionou — só sem enviar nada para a nuvem.
     */
    public synchronized void signOutLocally() {
        if (prefs != null) {
            // O identificador do aparelho sobrevive: ele descreve o aparelho,
            // não a sessão, e recriá-lo a cada login encheria a lista de
            // dispositivos da conta com entradas repetidas.
            String device = read(CHAVE_DISPOSITIVO_ID);
            prefs.edit().clear().apply();
            if (device != null) {
                write(CHAVE_DISPOSITIVO_ID, device);
            }
        }
        fallback.clearExceptDevice();
    }

    // -------------------------------------------------------------------------
    // Leitura e escrita
    // -------------------------------------------------------------------------

    private String read(String chave) {
        if (usingFallback) {
            return fallback.get(chave);
        }
        return prefs.getString(chave, null);
    }

    private long readLong(String chave) {
        String valor = read(chave);
        if (valor == null) {
            return 0L;
        }
        try {
            return Long.parseLong(valor);
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    private void write(String chave, String valor) {
        if (usingFallback) {
            fallback.put(chave, valor);
            return;
        }
        if (valor == null) {
            prefs.edit().remove(chave).apply();
        } else {
            prefs.edit().putString(chave, valor).apply();
        }
    }

    private void write(String chave, long valor) {
        write(chave, String.valueOf(valor));
    }

    /** Sessão que não sobrevive ao fechamento do app. */
    private static final class MemorySession {
        private final java.util.Map<String, String> valores =
                new java.util.concurrent.ConcurrentHashMap<>();

        String get(String chave) {
            return valores.get(chave);
        }

        void put(String chave, String valor) {
            if (valor == null) {
                valores.remove(chave);
            } else {
                valores.put(chave, valor);
            }
        }

        void clearExceptDevice() {
            String device = valores.get(CHAVE_DISPOSITIVO_ID);
            valores.clear();
            if (device != null) {
                valores.put(CHAVE_DISPOSITIVO_ID, device);
            }
        }
    }
}
