package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import br.com.gameloop.estoquesimples.BuildConfig;

/**
 * Membros e convites da empresa.
 *
 * Nenhum método aqui decide o que o usuário pode fazer — quem decide é o
 * servidor, que revalida a permissão em toda chamada. A tela usa o papel
 * apenas para não oferecer um botão que resultaria em erro.
 */
public final class TeamClient {

    /** Papéis que podem ser concedidos pelo app, do mais amplo ao mais restrito. */
    public static final String[] PAPEIS = {
            "administrador", "gerente", "operador", "consulta"
    };

    private final ApiClient api;
    private final SessionManager session;

    public TeamClient(Context context) {
        this.api = new ApiClient();
        this.session = SessionManager.get(context);
    }

    public static final class Member {
        public final String userId;
        public final String name;
        public final String email;
        public final String role;
        public final String status;

        Member(String userId, String name, String email, String role, String status) {
            this.userId = userId;
            this.name = name;
            this.email = email;
            this.role = role;
            this.status = status;
        }

        public boolean isSuspenso() {
            return "suspended".equals(status);
        }
    }

    public static final class Invite {
        public final String id;
        public final String email;
        public final String role;
        public final String status;
        public final String expiraEm;

        Invite(String id, String email, String role, String status, String expiraEm) {
            this.id = id;
            this.email = email;
            this.role = role;
            this.status = status;
            this.expiraEm = expiraEm;
        }

        public boolean isPendente() {
            return "pendente".equals(status);
        }
    }

    // -------------------------------------------------------------------------
    // Membros
    // -------------------------------------------------------------------------

    public List<Member> members() throws ApiException {
        JSONArray lista = api.get(caminho("/members"), session.accessToken())
                .body.optJSONArray("members");

        List<Member> membros = new ArrayList<>();
        if (lista == null) {
            return membros;
        }
        for (int i = 0; i < lista.length(); i++) {
            JSONObject item = lista.optJSONObject(i);
            if (item == null) {
                continue;
            }
            membros.add(new Member(
                    item.optString("userId", null),
                    item.optString("name", ""),
                    item.optString("email", ""),
                    item.optString("role", ""),
                    item.optString("status", "active")));
        }
        return membros;
    }

    public void changeRole(String userId, String role) throws ApiException {
        JSONObject corpo = objeto("role", role);
        api.put(caminho("/members/" + userId + "/role"), corpo, session.accessToken());
    }

    public void setSuspended(String userId, boolean suspenso) throws ApiException {
        JSONObject corpo = objeto("status", suspenso ? "suspended" : "active");
        api.put(caminho("/members/" + userId + "/status"), corpo, session.accessToken());
    }

    public void remove(String userId) throws ApiException {
        api.delete(caminho("/members/" + userId), session.accessToken());
    }

    // -------------------------------------------------------------------------
    // Convites
    // -------------------------------------------------------------------------

    public List<Invite> invites() throws ApiException {
        JSONArray lista = api.get(caminho("/invites"), session.accessToken())
                .body.optJSONArray("invites");

        List<Invite> convites = new ArrayList<>();
        if (lista == null) {
            return convites;
        }
        for (int i = 0; i < lista.length(); i++) {
            JSONObject item = lista.optJSONObject(i);
            if (item == null) {
                continue;
            }
            convites.add(new Invite(
                    item.optString("id", null),
                    item.optString("email", ""),
                    item.optString("roleKey", ""),
                    item.optString("status", ""),
                    item.optString("expiresAt", "")));
        }
        return convites;
    }

    /**
     * Convida alguém.
     *
     * O link em si nunca passa por aqui: ele existe uma única vez, no e-mail
     * enviado ao convidado. Isso é o que impede que quem administra a empresa
     * entre na conta de outra pessoa usando o próprio convite que emitiu.
     */
    public void invite(String email, String role) throws ApiException {
        try {
            JSONObject corpo = new JSONObject();
            corpo.put("email", email);
            corpo.put("roleKey", role);
            api.post(caminho("/invites"), corpo, session.accessToken());
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Não foi possível montar o convite.", null);
        }
    }


    public void cancelInvite(String inviteId) throws ApiException {
        api.delete(caminho("/invites/" + inviteId), session.accessToken());
    }

    // -------------------------------------------------------------------------
    // Aceite (não exige empresa selecionada, e às vezes nem conta)
    // -------------------------------------------------------------------------

    public static final class Preview {
        public final String empresa;
        public final String papel;
        public final String email;
        public final boolean temConta;

        Preview(String empresa, String papel, String email, boolean temConta) {
            this.empresa = empresa;
            this.papel = papel;
            this.email = email;
            this.temConta = temConta;
        }
    }

    public Preview previewInvite(String token) throws ApiException {
        JSONObject corpo = api.get("/v1/invites/" + token, null).body;
        return new Preview(
                corpo.optString("workspaceName", "Empresa"),
                corpo.optString("roleKey", ""),
                corpo.optString("email", ""),
                corpo.optBoolean("hasAccount", false));
    }

    /**
     * Aceita o convite.
     *
     * Com {@code nome} e {@code senha} nulos, aceita em nome da sessão atual;
     * caso contrário cria a conta do convidado. O servidor confere que o e-mail
     * autenticado é o mesmo do convite, então repassar o link não dá acesso a
     * ninguém.
     *
     * @return o id da empresa em que a pessoa entrou.
     */
    public String acceptInvite(String token, String nome, String senha) throws ApiException {
        try {
            JSONObject corpo = new JSONObject();
            if (nome != null && senha != null) {
                corpo.put("name", nome);
                corpo.put("password", senha);
                corpo.put("device", deviceInfo());
            }

            boolean autenticado = nome == null || senha == null;
            JSONObject resposta = api.post("/v1/invites/" + token + "/accept", corpo,
                    autenticado ? session.accessToken() : null).body;

            // Quem criou a conta agora já recebe a sessão na resposta: pedir um
            // login logo depois de digitar a senha seria repetir o mesmo passo.
            JSONObject auth = resposta.optJSONObject("auth");
            if (auth != null) {
                session.storeSession(auth);
            } else {
                // Entrar numa empresa muda as permissões da conta: o token
                // guardado aqui ainda não conhece a empresa nova.
                session.invalidateAccessToken();
            }
            return resposta.optString("workspaceId", null);

        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Não foi possível montar o pedido.", null);
        }
    }

    // -------------------------------------------------------------------------
    // Apoio
    // -------------------------------------------------------------------------


    private String caminho(String sufixo) throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            throw new ApiException(0, "SEM_EMPRESA",
                    "Escolha uma empresa antes de gerenciar a equipe.", null);
        }
        return "/v1/workspaces/" + workspaceId + sufixo;
    }

    private JSONObject objeto(String chave, String valor) throws ApiException {
        try {
            return new JSONObject().put(chave, valor);
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Não foi possível montar o pedido.", null);
        }
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

    /**
     * O que aquele papel pode fazer, em linguagem de quem administra a empresa.
     *
     * Espelha as permissões do servidor sem listar chaves técnicas. Quem
     * convida precisa entender a diferença antes de escolher, não depois.
     */
    public static String descricaoDoPapel(String role) {
        if (role == null) {
            return "";
        }
        switch (role) {
            case "proprietario":
                return "Controle total, inclusive assinatura, transferência e exclusão da empresa.";
            case "administrador":
                return "Gerencia produtos, movimentações e equipe. Não transfere nem exclui a empresa e não cuida da assinatura.";
            case "gerente":
                return "Gerencia produtos e movimentações. Vê quem está na equipe, mas não convida nem remove pessoas.";
            case "operador":
                return "Cadastra e edita produtos e registra entradas e saídas. Não exclui produtos nem gerencia a equipe.";
            case "consulta":
                return "Apenas visualiza o estoque. Não altera cadastros nem movimentações.";
            default:
                return "";
        }
    }

    /** Texto do aviso que explica os papéis que o convite pode oferecer. */
    public static String textoAjudaPapeis() {
        StringBuilder texto = new StringBuilder();
        texto.append("O proprietário é quem criou a empresa e não entra por convite.\n\n");
        for (String papel : PAPEIS) {
            texto.append(papelLegivel(papel)).append('\n');
            texto.append(descricaoDoPapel(papel)).append("\n\n");
        }
        return texto.toString().trim();
    }

    /** Rótulo do papel em português, para a tela não expor a chave técnica. */
    public static String papelLegivel(String role) {
        if (role == null) {
            return "";
        }
        switch (role) {
            case "proprietario":
                return "Proprietário";
            case "administrador":
                return "Administrador";
            case "gerente":
                return "Gerente";
            case "operador":
                return "Operador";
            case "consulta":
                return "Somente consulta";
            default:
                return role;
        }
    }
}
