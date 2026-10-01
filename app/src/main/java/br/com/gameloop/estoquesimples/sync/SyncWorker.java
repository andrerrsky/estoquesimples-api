package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import br.com.gameloop.estoquesimples.data.LocalBackup;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.data.SyncGate;
import br.com.gameloop.estoquesimples.data.SyncMeta;

/**
 * Sincronização em segundo plano.
 *
 * Roda no WorkManager, e não numa thread solta, porque precisa sobreviver ao
 * fechamento do app: quem registra uma saída de estoque e fecha o aplicativo
 * espera que ela chegue à nuvem mesmo assim. O WorkManager também respeita as
 * restrições de bateria e rede do sistema, o que evita drenar o aparelho
 * tentando enviar sem sinal.
 *
 * O worker é deliberadamente conservador: qualquer condição que não permita
 * sincronizar resulta em sucesso silencioso, não em falha. Falhar aqui geraria
 * novas tentativas e notificações de erro para uma situação normal — o usuário
 * simplesmente não tem conta, ou não tem assinatura.
 */
public final class SyncWorker extends Worker {

    private static final String TAG = "SyncWorker";

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();

        RemoteConfig config = new RemoteConfig(context);
        config.refresh();

        if (!config.isSyncEnabled()) {
            // Feature flag remota: sincronização desligada de propósito.
            SyncGate.setActive(false);
            return Result.success();
        }
        if (!config.isProtocolSupported()) {
            Log.i(TAG, "versão do app antiga demais para o protocolo atual");
            return Result.success();
        }

        SessionManager session = SessionManager.get(context);
        if (!session.isSignedIn() || session.workspaceId() == null) {
            SyncGate.setActive(false);
            return Result.success();
        }

        // Com sessão e empresa, a fila continua ativa mesmo sem direito de
        // rede agora. Perder a assinatura ou tomar 403 não pode impedir que
        // edições locais sejam enfileiradas — a fila é o registro do que
        // precisa subir quando o acesso voltar.
        SyncGate.setActive(true);

        EntitlementManager entitlements = new EntitlementManager(context);
        try {
            entitlements.refresh();
        } catch (ApiException e) {
            // Sem rede, vale o último retrato conhecido. É exatamente para isso
            // que ele tem prazo de validade.
            if (!e.isTransient()) {
                return handleApiFailure(context, e);
            }
        }

        if (!entitlements.canSync()) {
            recordStatus(context, entitlements.isStale()
                    ? "Não foi possível confirmar sua conta na nuvem. Os dados seguem no aparelho."
                    : "A sincronização na nuvem não está disponível para esta empresa agora. "
                            + "Os dados seguem no aparelho.");
            return Result.success();
        }

        try {
            return synchronize(context, config, session);
        } catch (ApiException e) {
            return handleApiFailure(context, e);
        } catch (Exception e) {
            Log.e(TAG, "falha inesperada na sincronização", e);
            recordStatus(context, "Erro inesperado ao sincronizar.");
            return Result.retry();
        }
    }

    private Result synchronize(Context context, RemoteConfig config, SessionManager session)
            throws ApiException {
        SQLiteDatabase db = LocalDb.open(context);
        SyncMeta meta = new SyncMeta(db);
        ApiClient api = new ApiClient();
        Interrupcao interrupcao = this::isStopped;

        SyncEngine engine = new SyncEngine(context, db, api, session,
                config.maxBatchItems(), interrupcao);
        InitialUpload upload = new InitialUpload(db, api, session, config.maxBatchItems());

        if (!upload.isComplete()) {
            // Antes do primeiro envio, sempre uma cópia do banco. É o único
            // ponto de retorno se a carga inicial correr mal.
            LocalBackup.create(context, db, "carga-inicial");
            try {
                upload.run(null);
            } catch (ApiException e) {
                if (!"SYNC_ALREADY_SEEDED".equals(e.getCode())) {
                    throw e;
                }
                // Segundo aparelho entrando numa empresa que já tem dados. O
                // banco local dele é quase sempre uma cópia velha; enviá-lo por
                // cima duplicaria o que a equipe já usa.
                int recebidas = engine.adoptCloudState();
                new SyncMeta(db).put(SyncMeta.ULTIMO_ERRO,
                        "Este aparelho passou a usar os dados da empresa na nuvem. "
                                + "Uma cópia do que havia aqui ficou guardada.");
                Log.i(TAG, "estado da nuvem adotado com " + recebidas + " registro(s)");
            }
        }

        SyncEngine.Resultado resultado = engine.run();

        int pendentes = new OutboxRepository(db).pendingCount();
        meta.put(SyncMeta.ULTIMA_SINCRONIZACAO, System.currentTimeMillis());
        meta.put(SyncMeta.DESVIO_RELOGIO, api.getClockSkewMs());
        meta.remove(SyncMeta.ULTIMO_ERRO);
        meta.remove(SyncMeta.BLOQUEIO_PLANO);

        Log.i(TAG, "sincronização concluída: " + resultado.enviadas + " enviada(s), "
                + resultado.recebidas + " recebida(s), " + resultado.conflitos + " conflito(s), "
                + resultado.recusadas + " recusada(s), " + pendentes + " na fila");

        // Operação recusada em definitivo não se resolve sozinha. O aviso fica
        // na tela de conta em vez de sumir junto com o registro do worker.
        if (new OutboxRepository(db).failedCount() > 0) {
            meta.put(SyncMeta.ULTIMO_ERRO,
                    "Algumas alterações não foram aceitas. Veja os detalhes na tela de conta.");
        }
        return Result.success();
    }

    private Result handleApiFailure(Context context, ApiException e) {
        // Papel alterado por um administrador: o token descreve permissões que
        // não existem mais. Descartá-lo e tentar de novo renova o acesso sem
        // exigir login — expulsar alguém do app por uma mudança de papel seria
        // desproporcional.
        if (e.isPermissionStale()) {
            SessionManager.get(context).invalidateAccessToken();
            return Result.retry();
        }

        recordStatus(context, e.userMessage());

        // Teto do plano ou equipe sem assinatura: nada foi perdido, a fila
        // espera. A tela inicial mostra o aviso com o caminho para o plano.
        if (e.isPlanBlocked()) {
            try {
                new SyncMeta(LocalDb.open(context)).put(SyncMeta.BLOQUEIO_PLANO, e.userMessage());
            } catch (Exception ignored) {
                // sem o aviso na tela inicial a tela de conta ainda explica
            }
        }

        if (e.isTransient()) {
            // O WorkManager aplica o próprio backoff; devolver retry evita
            // duplicar a política de repetição em dois lugares.
            return Result.retry();
        }
        if (e.needsReauth() || e.getStatusCode() == 403) {
            // Nada é apagado e a fila continua recebendo edições locais.
            // Só as tentativas de rede param até o direito voltar.
            return Result.success();
        }
        Log.w(TAG, "sincronização recusada: " + e.getCode());
        return Result.success();
    }

    private void recordStatus(Context context, String mensagem) {
        try {
            new SyncMeta(LocalDb.open(context)).put(SyncMeta.ULTIMO_ERRO, mensagem);
        } catch (Exception e) {
            Log.w(TAG, "não foi possível registrar o status da sincronização", e);
        }
    }
}
