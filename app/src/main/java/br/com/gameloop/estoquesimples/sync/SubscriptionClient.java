package br.com.gameloop.estoquesimples.sync;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

/**
 * Assinatura da empresa na API.
 *
 * O app envia só o {@code purchaseToken}; quem decide se há direito é o
 * servidor consultando o Google. Nada aqui grava "assinante = true" a partir
 * do resultado do Billing local.
 */
public final class SubscriptionClient {

    private final ApiClient api;
    private final SessionManager session;

    public SubscriptionClient(Context context) {
        this.api = new ApiClient();
        this.session = SessionManager.get(context);
    }

    public static final class Assinatura {
        public final String id;
        public final String planKey;
        public final String state;
        public final boolean autoRenewing;
        public final String startedAt;
        public final String currentPeriodEnd;
        public final String lastVerifiedAt;
        public final String productId;

        Assinatura(String id, String planKey, String state, boolean autoRenewing,
                   String startedAt, String currentPeriodEnd, String lastVerifiedAt,
                   String productId) {
            this.id = id;
            this.planKey = planKey;
            this.state = state;
            this.autoRenewing = autoRenewing;
            this.startedAt = startedAt;
            this.currentPeriodEnd = currentPeriodEnd;
            this.lastVerifiedAt = lastVerifiedAt;
            this.productId = productId;
        }
    }

    /**
     * Vincula o comprovante do Google Play à empresa selecionada.
     *
     * A chave de idempotência é estável no token: se a resposta se perder no
     * caminho, o reenvio devolve o mesmo entitlement em vez de criar vínculo
     * duplicado.
     */
    public JSONObject link(String purchaseToken) throws ApiException {
        if (purchaseToken == null || purchaseToken.isEmpty()) {
            throw new ApiException(0, ApiException.TOKEN_INVALIDO,
                    "Comprovante de compra ausente.", null);
        }
        try {
            JSONObject body = new JSONObject();
            body.put("purchaseToken", purchaseToken);
            return api.postIdempotent(
                    caminho("/billing/subscriptions"),
                    body,
                    session.accessToken(),
                    "link-" + sha256Hex(purchaseToken)).body;
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO",
                    "Não foi possível montar o pedido de vinculação.", null);
        }
    }

    /** Revalida a assinatura junto ao Google (atalho de suporte). */
    public JSONObject refresh() throws ApiException {
        return api.post(caminho("/billing/refresh"), new JSONObject(), session.accessToken()).body;
    }

    public List<Assinatura> history() throws ApiException {
        JSONArray lista = api.get(caminho("/billing/subscriptions"), session.accessToken())
                .body.optJSONArray("subscriptions");

        List<Assinatura> resultado = new ArrayList<>();
        if (lista == null) {
            return resultado;
        }
        for (int i = 0; i < lista.length(); i++) {
            JSONObject item = lista.optJSONObject(i);
            if (item == null) {
                continue;
            }
            resultado.add(new Assinatura(
                    item.optString("id", null),
                    item.optString("planKey", ""),
                    item.optString("state", ""),
                    item.optBoolean("autoRenewing", false),
                    item.optString("startedAt", null),
                    item.optString("currentPeriodEnd", null),
                    item.optString("lastVerifiedAt", ""),
                    item.optString("productId", "")));
        }
        return resultado;
    }

    private String caminho(String sufixo) throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            throw new ApiException(0, "SEM_EMPRESA",
                    "Escolha uma empresa antes de gerenciar a assinatura.", null);
        }
        return "/v1/workspaces/" + workspaceId + sufixo;
    }

    static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                hex.append(String.format(java.util.Locale.US, "%02x", b));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 faz parte do Android; se sumir, a chave de idempotência
            // ainda precisa ser estável o bastante para o mesmo token.
            return Integer.toHexString(value.hashCode());
        }
    }
}
