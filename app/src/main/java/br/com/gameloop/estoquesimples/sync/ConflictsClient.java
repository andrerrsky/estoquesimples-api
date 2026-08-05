package br.com.gameloop.estoquesimples.sync;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Conflitos que a nuvem não conseguiu resolver sozinha.
 *
 * O servidor já mesclou tudo que dava para mesclar. O que chega aqui são
 * escolhas de negócio — que nome o produto tem, quanto ele custa, se um produto
 * excluído deve voltar. Não existe resposta técnica para nenhuma delas, e
 * decidir por conta faria alguém vender pelo preço errado sem saber por quê.
 */
public final class ConflictsClient {

    public static final String ESCOLHA_MINHA = "meu";
    public static final String ESCOLHA_SERVIDOR = "servidor";
    public static final String ESCOLHA_RESTAURAR = "restaurar";

    private final ApiClient api;
    private final SessionManager session;

    public ConflictsClient(ApiClient api, SessionManager session) {
        this.api = api;
        this.session = session;
    }

    /** Um conflito como a tela apresenta. */
    public static final class Conflict {
        public final String id;
        public final String produto;
        public final String campo;
        public final String tipo;
        public final String valorLocal;
        public final String valorNuvem;

        Conflict(String id, String produto, String campo, String tipo,
                 String valorLocal, String valorNuvem) {
            this.id = id;
            this.produto = produto;
            this.campo = campo;
            this.tipo = tipo;
            this.valorLocal = valorLocal;
            this.valorNuvem = valorNuvem;
        }

        public boolean isExclusao() {
            return "exclusao_vs_edicao".equals(tipo);
        }

        /** Rótulo do campo em português, para não expor o nome técnico. */
        public String campoLegivel() {
            if (campo == null) {
                return "registro";
            }
            switch (campo) {
                case "name":
                    return "nome";
                case "unitValue":
                    return "preço";
                case "minStock":
                    return "estoque mínimo";
                case "description":
                    return "descrição";
                case "category":
                    return "categoria";
                case "supplier":
                    return "fornecedor";
                case "location":
                    return "localização";
                case "unit":
                    return "unidade";
                default:
                    return campo;
            }
        }
    }

    public List<Conflict> pending() throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            return new ArrayList<>();
        }

        JSONObject resposta = api.get(
                "/v1/workspaces/" + workspaceId + "/conflicts?status=pendente",
                session.accessToken()).body;

        List<Conflict> conflitos = new ArrayList<>();
        JSONArray lista = resposta.optJSONArray("conflicts");
        if (lista == null) {
            return conflitos;
        }

        for (int i = 0; i < lista.length(); i++) {
            JSONObject item = lista.optJSONObject(i);
            if (item == null) {
                continue;
            }
            conflitos.add(new Conflict(
                    item.optString("id", null),
                    item.isNull("entityName") ? "Produto" : item.optString("entityName"),
                    item.isNull("field") ? null : item.optString("field"),
                    item.optString("kind", "campo"),
                    texto(item, "discardedValue"),
                    texto(item, "keptValue")));
        }
        return conflitos;
    }

    public void resolve(String conflictId, String escolha) throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            throw new ApiException(0, "SEM_EMPRESA",
                    "Escolha uma empresa antes de resolver conflitos.", null);
        }

        try {
            JSONObject corpo = new JSONObject();
            corpo.put("escolha", escolha);
            api.post("/v1/workspaces/" + workspaceId + "/conflicts/" + conflictId + "/resolve",
                    corpo, session.accessToken());
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO", "Falha ao montar a decisão.", null);
        }
    }

    /**
     * O valor guardado pode ser texto, número ou o registro inteiro. A tela
     * mostra o que der para mostrar; um JSON cru na frente do usuário não
     * ajuda ninguém a decidir.
     */
    private static String texto(JSONObject item, String campo) {
        if (item.isNull(campo)) {
            return "(vazio)";
        }
        Object valor = item.opt(campo);
        if (valor instanceof JSONObject || valor instanceof JSONArray) {
            return "(alteração guardada)";
        }
        return String.valueOf(valor);
    }
}
