package br.com.gameloop.estoquesimples.analytics;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

import br.com.gameloop.estoquesimples.BuildConfig;
import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Envia a fila de eventos para {@code POST /v1/analytics/events}.
 *
 * Com sessão, o lote vai com o Bearer e a API atribui os eventos ao usuário;
 * sem sessão, vai sem cabeçalho e fica só com a instalação. Reenviar é
 * seguro: o {@code id} de cada evento é a chave de idempotência do servidor.
 */
public final class AnalyticsWorker extends Worker {

    private static final String TAG = "AnalyticsWorker";
    private static final int LOTE = 200;
    private static final int MAX_LOTES_POR_EXECUCAO = 10;
    private static final int MAX_TENTATIVAS = 8;
    private static final long IDADE_MAXIMA_MS = 30L * 24 * 60 * 60_000L;

    public AnalyticsWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        AnalyticsDb fila = AnalyticsDb.helper(context);
        fila.descartarVelhos(MAX_TENTATIVAS, System.currentTimeMillis() - IDADE_MAXIMA_MS);

        SessionManager session = SessionManager.get(context);
        ApiClient api = new ApiClient();

        for (int i = 0; i < MAX_LOTES_POR_EXECUCAO; i++) {
            List<AnalyticsDb.Pendente> lote = fila.proximos(LOTE);
            if (lote.isEmpty()) {
                return Result.success();
            }

            String token = null;
            if (session.isSignedIn()) {
                try {
                    token = session.accessToken();
                } catch (ApiException e) {
                    // Sessão que não renova: envia sem atribuição a usuário.
                    token = null;
                }
            }

            try {
                api.post("/v1/analytics/events", corpo(session, lote), token);
                fila.remover(lote);
            } catch (ApiException e) {
                if (e.getStatusCode() == 401 && token != null) {
                    // Token recusado: o lote segue sem ele na próxima passagem.
                    session.invalidateAccessToken();
                    fila.marcarTentativa(lote);
                    return Result.retry();
                }
                if (e.isTransient()) {
                    fila.marcarTentativa(lote);
                    return Result.retry();
                }
                // 4xx que não melhora repetindo (lote inválido): descarta para
                // não travar a fila atrás dele.
                Log.w(TAG, "lote de eventos recusado pela API e descartado: " + e.getCode());
                fila.remover(lote);
            } catch (Exception e) {
                Log.w(TAG, "falha ao montar o lote de eventos", e);
                fila.marcarTentativa(lote);
                return Result.retry();
            }
        }
        return Result.success();
    }

    private static JSONObject corpo(SessionManager session, List<AnalyticsDb.Pendente> lote) throws Exception {
        JSONObject device = new JSONObject()
                .put("installId", session.deviceId())
                .put("platform", "android")
                .put("appVersionCode", BuildConfig.VERSION_CODE);

        JSONArray events = new JSONArray();
        for (AnalyticsDb.Pendente evento : lote) {
            JSONObject item = new JSONObject()
                    .put("id", evento.id)
                    .put("name", evento.name)
                    .put("occurredAt", evento.occurredAt);
            if (evento.workspaceId != null) {
                item.put("workspaceId", evento.workspaceId);
            }
            if (evento.sessionKey != null) {
                item.put("sessionKey", evento.sessionKey);
            }
            if (evento.properties != null) {
                item.put("properties", new JSONObject(evento.properties));
            }
            events.put(item);
        }
        return new JSONObject().put("device", device).put("events", events);
    }
}
