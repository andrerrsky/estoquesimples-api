package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import br.com.gameloop.estoquesimples.PhotoPathHelper;
import br.com.gameloop.estoquesimples.data.LocalBackup;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.data.RemoteChanges;
import br.com.gameloop.estoquesimples.data.SyncGate;
import br.com.gameloop.estoquesimples.data.SyncMeta;

/**
 * Sincronização incremental: sobe o que mudou aqui, baixa o que mudou lá.
 *
 * As duas metades são independentes de propósito. O envio percorre a fila de
 * saída; a leitura percorre a sequência do servidor a partir de um cursor.
 * Nenhuma depende de a outra ter terminado, o que importa porque a conexão vai
 * cair no meio — e quando isso acontece, o que já subiu está subido e o que já
 * desceu está aplicado, sem estado intermediário para consertar depois.
 */
public final class SyncEngine {

    private static final String TAG = "SyncEngine";

    private final Context context;
    private final SQLiteDatabase db;
    private final ApiClient api;
    private final SessionManager session;
    private final OutboxRepository outbox;
    private final SyncMeta meta;
    private final int tamanhoLote;
    private final Interrupcao interrupcao;

    public SyncEngine(Context context, SQLiteDatabase db, ApiClient api, SessionManager session,
                      int tamanhoLote, Interrupcao interrupcao) {
        this.context = context.getApplicationContext();
        this.db = db;
        this.api = api;
        this.session = session;
        this.outbox = new OutboxRepository(db);
        this.meta = new SyncMeta(db);
        this.tamanhoLote = tamanhoLote;
        this.interrupcao = interrupcao;
    }

    private RemoteChanges remoteChanges() {
        return new RemoteChanges(db).withImagesFolder(PhotoPathHelper.getImagesFolder(context));
    }

    private void conferirParada() throws ApiException {
        if (interrupcao != null && interrupcao.pediuParada()) {
            throw new ApiException(0, ApiException.INTERROMPIDO,
                    "Sincronização interrompida; será retomada.", null);
        }
    }

    /** Resumo de uma rodada, para a tela de status e para os registros. */
    public static final class Resultado {
        public final int enviadas;
        public final int recusadas;
        public final int conflitos;
        public final int recebidas;
        public final boolean recarregou;

        Resultado(int enviadas, int recusadas, int conflitos, int recebidas, boolean recarregou) {
            this.enviadas = enviadas;
            this.recusadas = recusadas;
            this.conflitos = conflitos;
            this.recebidas = recebidas;
            this.recarregou = recarregou;
        }
    }

    /**
     * Uma rodada completa.
     *
     * O envio vem primeiro. Baixar antes faria as alterações locais ainda não
     * enviadas serem comparadas com um servidor que não as conhece, e o app
     * mostraria conflito com o próprio trabalho do usuário.
     *
     * <p>A recarga completa pode ser exigida nas duas metades, e por isso é
     * tratada nas duas. Exigida durante o envio, ela chegava como uma recusa
     * qualquer: o worker registrava sucesso, ninguém recarregava, e o aparelho
     * ficava travado repetindo o mesmo envio em toda rodada seguinte.
     */
    public Resultado run() throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            throw new ApiException(0, "SEM_EMPRESA",
                    "Escolha uma empresa antes de sincronizar.", null);
        }

        boolean recarregou = false;
        Envio envio;
        try {
            envio = push(workspaceId);
        } catch (ApiException e) {
            if (!e.needsResync()) {
                throw e;
            }
            // A fila continua válida: são alterações locais que a nuvem não
            // conhece. Recarrega-se o que veio de lá e o envio recomeça.
            Log.w(TAG, "recarga completa exigida durante o envio");
            fullResync(workspaceId);
            recarregou = true;
            envio = push(workspaceId);
        }

        int recebidas;
        try {
            recebidas = pull(workspaceId);
        } catch (ApiException e) {
            if (!e.needsResync()) {
                throw e;
            }
            // O ponto de leitura não vale mais. Recarregar é lento, mas é a
            // única saída correta: continuar dali esconderia exclusões que este
            // aparelho nunca chegou a receber.
            Log.w(TAG, "recarga completa exigida pelo servidor");
            recebidas = fullResync(workspaceId);
            recarregou = true;
        }

        if (envio.conflitos > 0) {
            atualizarPendentes(workspaceId);
        }

        return new Resultado(envio.enviadas, envio.recusadas, envio.conflitos, recebidas,
                recarregou);
    }

    /**
     * Conta quantas decisões ficaram esperando uma pessoa.
     *
     * Consultado só quando a rodada produziu conflito. Um conflito que ninguém
     * vê é o mesmo que um dado perdido, mas perguntar isso ao servidor a cada
     * sincronização gastaria rede para quase sempre receber zero.
     */
    private void atualizarPendentes(String workspaceId) {
        try {
            JSONObject resposta = api.get(
                    "/v1/workspaces/" + workspaceId + "/conflicts?status=pendente&limit=1",
                    session.accessToken()).body;
            meta.put(SyncMeta.CONFLITOS_PENDENTES, resposta.optLong("pending", 0L));
        } catch (ApiException e) {
            Log.w(TAG, "não foi possível contar os conflitos pendentes: " + e.getCode());
        }
    }

    /**
     * Adota o que já existe na nuvem, descartando a carga inicial deste
     * aparelho.
     *
     * Acontece quando alguém instala o app num segundo aparelho e entra numa
     * empresa que já tem dados. O banco local desse aparelho costuma ser uma
     * cópia velha ou um cadastro de testes; enviá-lo por cima duplicaria tudo
     * o que a equipe já usa. A cópia de segurança feita antes garante que nada
     * é irreversível.
     */
    public int adoptCloudState() throws ApiException {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            throw new ApiException(0, "SEM_EMPRESA",
                    "Escolha uma empresa antes de sincronizar.", null);
        }

        int recebidas = fullResync(workspaceId);

        db.beginTransaction();
        try {
            meta.put(SyncMeta.CARGA_INICIAL_CONCLUIDA, true);
            meta.put(SyncMeta.WORKSPACE_ID, workspaceId);
            meta.remove(SyncMeta.UPLOAD_ID);
            meta.remove(SyncMeta.UPLOAD_PROXIMO_LOTE);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }

        return recebidas;
    }

    // -------------------------------------------------------------------------
    // Envio
    // -------------------------------------------------------------------------

    private static final class Envio {
        int enviadas;
        int recusadas;
        int conflitos;
    }

    private Envio push(String workspaceId) throws ApiException {
        Envio envio = new Envio();
        outbox.compact();

        while (true) {
            conferirParada();

            List<OutboxRepository.Operation> lote = outbox.nextBatch(tamanhoLote);
            if (lote.isEmpty()) {
                return envio;
            }

            JSONObject corpo = montarLote(lote);
            JSONObject resposta;
            try {
                resposta = api.post("/v1/workspaces/" + workspaceId + "/sync/push",
                        corpo, session.accessToken()).body;
            } catch (ApiException e) {
                if (e.isTransient()) {
                    // Reagendar cada operação em vez de perder o lote: o
                    // intervalo cresce por operação e as que já falharam muito
                    // deixam de bloquear as demais na próxima rodada.
                    for (OutboxRepository.Operation operacao : lote) {
                        outbox.markTransientFailure(operacao.opId, e.userMessage());
                    }
                }
                throw e;
            }

            int decididas = aplicarResultados(resposta.optJSONArray("results"), lote, envio);

            // Uma rodada que não decidiu nada não decidirá na próxima: o lote
            // seguinte seria idêntico a este, e com o lote cheio o laço
            // reenviaria as mesmas operações para sempre. Acontece quando a
            // resposta chega sem o vetor de resultados — um servidor mais novo,
            // um intermediário que reescreveu o corpo. Sai-se do laço tratando
            // como falha transitória, que é o que ela é: nada foi perdido e a
            // próxima rodada tenta de novo, mais devagar.
            if (decididas == 0) {
                for (OutboxRepository.Operation operacao : lote) {
                    outbox.markTransientFailure(operacao.opId,
                            "O servidor não confirmou o envio. Vamos tentar de novo.");
                }
                Log.w(TAG, "lote sem nenhuma operação confirmada; envio interrompido");
                return envio;
            }

            if (lote.size() < tamanhoLote) {
                return envio;
            }
        }
    }

    private JSONObject montarLote(List<OutboxRepository.Operation> lote) throws ApiException {
        try {
            JSONArray operacoes = new JSONArray();
            for (OutboxRepository.Operation operacao : lote) {
                JSONObject json = new JSONObject();
                json.put("opId", operacao.opId);
                json.put("entity", operacao.entityType);
                json.put("op", operacao.op);
                json.put("entityId", operacao.entityId);
                if (operacao.baseRev != null) {
                    json.put("baseRev", operacao.baseRev);
                }
                json.put("payload", new JSONObject(operacao.payload));
                operacoes.put(json);
            }

            JSONObject corpo = new JSONObject();
            corpo.put("operations", operacoes);
            return corpo;
        } catch (JSONException e) {
            throw new ApiException(0, "PAYLOAD_INVALIDO",
                    "Falha ao montar as alterações para envio.", null);
        }
    }

    /**
     * Processa o que o servidor respondeu sobre cada operação do lote.
     *
     * @return quantas operações tiveram algum desfecho — confirmadas,
     *         conflitantes ou recusadas. Zero significa que o lote continua
     *         inteiro na fila, e quem chama precisa saber disso para não
     *         reenviá-lo indefinidamente.
     */
    private int aplicarResultados(JSONArray resultados, List<OutboxRepository.Operation> lote,
                                  Envio envio) {
        if (resultados == null) {
            return 0;
        }

        // O tipo da entidade vem da operação enviada, não da resposta: é aqui
        // que sabemos, sem depender do servidor, se um "rev" confirmado se
        // refere a um produto ou a uma movimentação.
        Map<String, String> tipoPorOperacao = new HashMap<>();
        for (OutboxRepository.Operation operacao : lote) {
            tipoPorOperacao.put(operacao.opId, operacao.entityType);
        }

        List<String> confirmadas = new ArrayList<>();
        int decididas = 0;

        for (int i = 0; i < resultados.length(); i++) {
            JSONObject resultado = resultados.optJSONObject(i);
            if (resultado == null) {
                continue;
            }
            String opId = resultado.optString("opId", null);
            String status = resultado.optString("status", "");
            if (opId == null) {
                continue;
            }
            decididas++;

            if ("aplicada".equals(status) || "duplicada".equals(status)) {
                confirmadas.add(opId);
                aplicarVersaoConfirmada(resultado, tipoPorOperacao.get(opId));
                envio.enviadas++;

            } else if ("conflito".equals(status)) {
                // O outro aparelho chegou primeiro. Nesta etapa a versão do
                // servidor prevalece e substitui a local; a tela de resolução,
                // com o comparativo campo a campo, vem na etapa seguinte.
                confirmadas.add(opId);
                aplicarVersaoDoServidor(resultado);
                envio.conflitos++;

            } else {
                outbox.markPermanentFailure(opId,
                        resultado.optString("message", "Alteração recusada pelo servidor."));
                envio.recusadas++;
            }
        }

        outbox.markSent(confirmadas);
        return decididas;
    }

    /**
     * Alinha a versão local com a que o servidor confirmou.
     *
     * Sem isso, o contador local e o do servidor se afastam a cada envio, e a
     * próxima edição chegaria com uma versão de origem que o servidor não
     * reconhece — acusando conflito onde ninguém alterou nada.
     *
     * <p>Só para produtos. O UPDATE roda contra a tabela de produtos, e
     * executá-lo para toda operação confirmada significava, a cada movimentação
     * enviada, procurar em Estoque um uuid que é de movimentação: não achava
     * nada, mas varria a tabela — uma vez por movimentação, em toda
     * sincronização.
     */
    private void aplicarVersaoConfirmada(JSONObject resultado, String entityType) {
        if (!OutboxRepository.ENTITY_PRODUTO.equals(entityType) || !resultado.has("rev")) {
            return;
        }
        String entityId = resultado.optString("entityId", null);
        if (entityId == null) {
            return;
        }
        db.execSQL("UPDATE " + LocalDb.TABLE_PRODUCTS + " SET rev=? WHERE uuid=?",
                new Object[]{resultado.optLong("rev"), entityId});
    }

    private void aplicarVersaoDoServidor(JSONObject resultado) {
        JSONObject servidor = resultado.optJSONObject("server");
        if (servidor == null) {
            return;
        }
        // A supressão é desta thread e só dela: o que está sendo gravado veio
        // da nuvem e não pode voltar para a fila, mas quem estiver usando o app
        // neste instante continua com as próprias alterações sendo enfileiradas
        // normalmente.
        SyncGate.suppressForRemoteApply(true);
        try {
            JSONObject change = new JSONObject();
            change.put("entity", OutboxRepository.ENTITY_PRODUTO);
            change.put("deleted", !servidor.isNull("deletedAt"));
            change.put("data", servidor);

            JSONArray changes = new JSONArray();
            changes.put(change);

            // O cursor não avança aqui: esta versão veio pela resposta do
            // envio, não pela leitura ordenada, e tratá-la como leitura faria
            // o aparelho pular alterações de outras pessoas.
            if (remoteChanges().apply(changes, meta.get(SyncMeta.CURSOR, "0"))
                    == RemoteChanges.FALHOU) {
                Log.w(TAG, "não foi possível gravar a versão do servidor");
            }
        } catch (JSONException e) {
            Log.w(TAG, "não foi possível aplicar a versão do servidor", e);
        } finally {
            SyncGate.suppressForRemoteApply(false);
        }
    }

    // -------------------------------------------------------------------------
    // Leitura
    // -------------------------------------------------------------------------

    private int pull(String workspaceId) throws ApiException {
        return pullDesde(workspaceId, meta.getLong(SyncMeta.CURSOR, 0L), null);
    }

    /**
     * Baixa e aplica página a página até o servidor dizer que não há mais.
     *
     * A fila de saída fica suspensa nesta thread durante a aplicação: o que
     * chega da nuvem não é uma alteração do usuário e não pode voltar para lá
     * como se fosse. A suspensão é por thread justamente para não alcançar quem
     * estiver mexendo no estoque enquanto isso.
     *
     * <p>O laço para assim que uma página não é gravada por inteiro. O cursor
     * em memória avançava a cada volta sem olhar para o resultado da gravação:
     * uma página que falhava voltava atrás no banco, mas a página seguinte
     * gravava um cursor mais adiantado e a que falhou nunca mais era pedida.
     */
    private int pullDesde(String workspaceId, long cursorInicial, RemoteChanges acumulador)
            throws ApiException {
        int recebidas = 0;
        long cursor = cursorInicial;

        SyncGate.suppressForRemoteApply(true);
        try {
            while (true) {
                conferirParada();

                JSONObject resposta = api.get(
                        "/v1/workspaces/" + workspaceId + "/sync/pull"
                                + "?cursor=" + cursor + "&limit=" + tamanhoLote,
                        session.accessToken()).body;

                JSONArray changes = resposta.optJSONArray("changes");
                String proximoCursor = resposta.optString("nextCursor", String.valueOf(cursor));

                RemoteChanges aplicador = acumulador != null ? acumulador : remoteChanges();
                if (changes != null && changes.length() > 0) {
                    int aplicadas = aplicador.apply(changes, proximoCursor);
                    if (aplicadas == RemoteChanges.FALHOU) {
                        throw new ApiException(0, ApiException.FALHA_LOCAL,
                                "Não foi possível gravar o que veio da nuvem. "
                                        + "Vamos tentar de novo.", null);
                    }
                    recebidas += aplicadas;

                    if (aplicador.adiadoPorPendencia()) {
                        // Há alteração local esperando na fila para o mesmo
                        // registro. O cursor ficou parado antes dela de
                        // propósito; seguir para a página seguinte gravaria um
                        // cursor à frente e a versão do servidor sumiria.
                        Log.i(TAG, "leitura pausada: alteração local pendente para o registro");
                        return recebidas;
                    }
                }

                cursor = parseLong(proximoCursor, cursor);
                if (!resposta.optBoolean("hasMore", false)) {
                    return recebidas;
                }
            }
        } finally {
            SyncGate.suppressForRemoteApply(false);
        }
    }

    /**
     * Recarga completa, quando o cursor deste aparelho não vale mais.
     *
     * Varre o servidor desde o início e, ao terminar, marca como excluído o que
     * não apareceu: são registros apagados há tanto tempo que a lápide já foi
     * recolhida. O que ainda está na fila de saída é preservado — é alteração
     * local que a nuvem sequer viu.
     *
     * <p>A cópia de segurança é feita aqui, imediatamente antes da remoção, e
     * não só antes do primeiro envio. Esta é a operação que decide sozinha
     * excluir produtos e histórico a partir do que o servidor <b>não</b> disse,
     * e é a que mais precisa de um ponto de retorno.
     */
    private int fullResync(String workspaceId) throws ApiException {
        RemoteChanges acumulador = remoteChanges();
        int recebidas = pullDesde(workspaceId, 0L, acumulador);

        LocalBackup.create(context, db, "recarga-completa");
        int removidos = acumulador.removeAusentes();

        Log.i(TAG, "recarga completa: " + recebidas + " recebidas, " + removidos + " removidos");
        return recebidas;
    }

    private static long parseLong(String valor, long padrao) {
        try {
            return Long.parseLong(valor);
        } catch (NumberFormatException e) {
            return padrao;
        }
    }
}
