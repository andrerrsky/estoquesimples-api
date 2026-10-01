package br.com.gameloop.estoquesimples.sync;

import br.com.gameloop.estoquesimples.push.PushRegistrar;
import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import br.com.gameloop.estoquesimples.BuildConfig;

/**
 * Entrada, cadastro e escolha de empresa.
 *
 * Reúne as chamadas que a tela de conta precisa, mantendo a interface livre de
 * detalhes de protocolo. Nenhum método aqui pode ser chamado na thread
 * principal: todos fazem rede.
 */
public final class AccountService {

    private final Context context;
    private final ApiClient api;
    private final SessionManager session;

    public AccountService(Context context) {
        this.context = context.getApplicationContext();
        this.api = new ApiClient();
        this.session = SessionManager.get(context);
    }

    /** Empresa a que o usuário pertence. */
    public static final class Workspace {
        public final String id;
        public final String name;
        public final String role;
        public final boolean isOwner;
        public final int memberCount;

        Workspace(String id, String name, String role, boolean isOwner, int memberCount) {
            this.id = id;
            this.name = name;
            this.role = role;
            this.isOwner = isOwner;
            this.memberCount = memberCount;
        }
    }

    public void register(String name, String email, String password) throws ApiException {
        try {
            JSONObject body = new JSONObject();
            body.put("name", name);
            body.put("email", email);
            body.put("password", password);
            body.put("device", deviceInfo());

            ApiClient.Response response = api.post("/v1/auth/register", body, null);
            session.storeSession(response.body);
            PushRegistrar.register(context);
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Não foi possível montar o pedido.", null);
        }
    }

    public void login(String email, String password) throws ApiException {
        try {
            JSONObject body = new JSONObject();
            body.put("email", email);
            body.put("password", password);
            body.put("device", deviceInfo());

            ApiClient.Response response = api.post("/v1/auth/login", body, null);
            session.storeSession(response.body);
            PushRegistrar.register(context);
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Não foi possível montar o pedido.", null);
        }
    }

    public List<Workspace> listWorkspaces() throws ApiException {
        ApiClient.Response response = api.get("/v1/workspaces", session.accessToken());
        JSONArray array = response.body.optJSONArray("workspaces");

        List<Workspace> workspaces = new ArrayList<>();
        if (array == null) {
            return workspaces;
        }
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                continue;
            }
            workspaces.add(new Workspace(
                    item.optString("id", null),
                    item.optString("name", ""),
                    item.optString("role", ""),
                    item.optBoolean("isOwner", false),
                    item.optInt("memberCount", 0)));
        }
        return workspaces;
    }

    public Workspace createWorkspace(String name) throws ApiException {
        try {
            JSONObject body = new JSONObject();
            body.put("name", name);

            ApiClient.Response response = api.post("/v1/workspaces", body, session.accessToken());
            return new Workspace(
                    response.body.optString("id", null),
                    response.body.optString("name", name),
                    "proprietario", true, 1);
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Não foi possível montar o pedido.", null);
        }
    }

    public void selectWorkspace(Workspace workspace) {
        session.storeWorkspace(workspace.id, workspace.name, workspace.role);
    }

    /**
     * Atualiza nome, e-mail e se o endereço já foi confirmado.
     *
     * O token de acesso não carrega essa confirmação; sem consultar o perfil,
     * uma conta recém-criada parece dona da empresa e ainda assim não consegue
     * convidar ninguém.
     */
    public void refreshProfile() throws ApiException {
        session.storeUser(api.get("/v1/me", session.accessToken()).body);
    }

    public void confirmEmail(String token) throws ApiException {
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            api.post("/v1/auth/verify-email", body, null);
            session.setEmailVerified(true);
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO",
                    "Não foi possível montar a confirmação.", null);
        }
    }

    public void resendVerification() throws ApiException {
        api.post("/v1/auth/resend-verification", new JSONObject(), session.accessToken());
    }

    /**
     * Pede ao servidor para invalidar o refresh token.
     *
     * Não descarta a sessão local. Sem resposta HTTP a exceção sobe para a tela
     * decidir entre tentar de novo e sair mesmo assim.
     */
    public void revokeRemote() throws ApiException {
        api.post("/v1/auth/logout", new JSONObject(), session.accessToken());
    }

    /** Encerra a sessão neste aparelho, sem falar com o servidor. */
    public void logoutLocal() {
        session.signOutLocally();
    }

    private JSONObject deviceInfo() throws JSONException {
        JSONObject device = new JSONObject();
        device.put("installId", session.deviceId());
        device.put("platform", "android");
        device.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        device.put("osVersion", "Android " + Build.VERSION.RELEASE);
        device.put("appVersionCode", BuildConfig.VERSION_CODE);
        device.put("appVersionName", BuildConfig.VERSION_NAME);
        device.put("syncProtocolVersion", BuildConfig.SYNC_PROTOCOL);
        return device;
    }
}
