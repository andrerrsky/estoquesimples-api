package br.com.gameloop.estoquesimples.sync;

import android.content.Context;

import org.json.JSONObject;

/**
 * Cópia dos dados da nuvem no mesmo JSON que o aparelho exporta.
 *
 * Não altera o banco local: quem chama grava o arquivo onde o usuário
 * escolheu. Misturar download e importação no mesmo toque faria a nuvem
 * sobrescrever o estoque do aparelho sem o usuário ver o arquivo.
 */
public final class ExportClient {

    private final ApiClient api;
    private final SessionManager session;

    public ExportClient(Context context) {
        this.api = new ApiClient();
        this.session = SessionManager.get(context);
    }

    public JSONObject downloadJson() throws ApiException {
        String workspaceId = session.workspaceId();
        if (!session.isSignedIn() || workspaceId == null) {
            throw new ApiException(401, ApiException.NAO_AUTENTICADO,
                    "Entre na sua conta para baixar a cópia da nuvem.", null);
        }
        return api.getLarge(
                "/v1/workspaces/" + workspaceId + "/export",
                session.accessToken()).body;
    }
}
