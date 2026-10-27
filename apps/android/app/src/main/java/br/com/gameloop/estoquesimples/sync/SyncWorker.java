package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import br.com.gameloop.estoquesimples.data.LocalBackup;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.LocalMerge;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.data.SyncGate;
import br.com.gameloop.estoquesimples.data.SyncMeta;
import br.com.gameloop.estoquesimples.photos.PhotoSync;

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
        // A sincronização pode rodar com o app fechado (sem nenhuma tela aberta).
        br.com.gameloop.estoquesimples.diagnostics.ErrorReporter.install(context);

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
        SyncStatus.started();

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
            String motivo = entitlements.isStale()
                    ? "Não foi possível confirmar sua conta na nuvem. Os dados seguem no aparelho."
                    : "A sincronização na nuvem não está disponível para esta empresa agora. "
                            + "Os dados seguem no aparelho.";
            recordStatus(context, motivo);
            SyncStatus.failed(motivo);
            return Result.success();
        }

        try {
            return synchronize(context, config, session);
        } catch (ApiException e) {
            return handleApiFailure(context, e);
        } catch (Exception e) {
            Log.e(TAG, "falha inesperada na sincronização", e);
            br.com.gameloop.estoquesimples.diagnostics.ErrorReporter.report("sync", e);
            recordStatus(context, "Erro inesperado ao sincronizar.");
            SyncStatus.failed("Erro inesperado ao sincronizar. Vamos tentar de novo.");
            return Result.retry();
        }
    }

    /**
     * Uma rodada por vez no processo. O trabalho periódico e o imediato têm
     * nomes diferentes no WorkManager e podiam rodar juntos: as duas rodadas
     * adotavam a nuvem ao mesmo tempo, disputavam os mesmos arquivos de foto
     * e a segunda apagava o aviso da primeira. A segunda espera e, quando
     * entra, encontra o trabalho feito.
     */
    private static final Object RODADA = new Object();

    private Result synchronize(Context context, RemoteConfig config, SessionManager session)
            throws ApiException {
        synchronized (RODADA) {
            return synchronizeLocked(context, config, session);
        }
    }

    private Result synchronizeLocked(Context context, RemoteConfig config, SessionManager session)
            throws ApiException {
        SQLiteDatabase db = LocalDb.open(context);
        SyncMeta meta = new SyncMeta(db);
        ApiClient api = new ApiClient();
        Interrupcao interrupcao = this::isStopped;

        SyncEngine engine = new SyncEngine(context, db, api, session,
                config.maxBatchItems(), interrupcao);
        InitialUpload upload = new InitialUpload(db, api, session, config.maxBatchItems());

        String avisoNovo = null;
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
                LocalMerge.Result mescla = engine.adoptCloudState();
                avisoNovo = mensagemDaMescla(mescla);
                meta.put(SyncMeta.AVISO_MESCLA, avisoNovo);
                // A adoção já conferiu tudo com a nuvem: não há o que reconciliar.
                meta.remove(SyncMeta.RECONCILIAR);
            }
        }

        // Banco trocado por uma cópia com a conta conectada: reconcilia com a
        // nuvem antes do envio normal (ver SyncMeta.RECONCILIAR).
        if (meta.getBoolean(SyncMeta.RECONCILIAR, false)) {
            if (!upload.isComplete()) {
                // Empresa ainda vazia na nuvem: a carga inicial acima já cuidou.
                meta.remove(SyncMeta.RECONCILIAR);
            } else {
                LocalBackup.create(context, db, "reconciliacao");
                LocalMerge.Result mescla = engine.reconcileAfterRestore();
                avisoNovo = mensagemDaRestauracao(mescla);
                meta.put(SyncMeta.AVISO_MESCLA, avisoNovo);
            }
        }

        // Fotos: as imagens sobem antes do envio da fila (a nuvem ignora um
        // photoHash cujo arquivo ainda não existe lá) e as novas descem depois
        // da leitura. Erro de foto nunca derruba a sincronização do estoque.
        PhotoSync photos = new PhotoSync(context, db, api, session, interrupcao);
        try {
            photos.uploadPending();
        } catch (RuntimeException e) {
            Log.w(TAG, "falha inesperada ao enviar fotos", e);
        }

        SyncEngine.Resultado resultado = engine.run();

        int fotosBaixadas = 0;
        try {
            fotosBaixadas = photos.downloadMissing();
        } catch (RuntimeException e) {
            Log.w(TAG, "falha inesperada ao baixar fotos", e);
        }

        int pendentes = new OutboxRepository(db).pendingCount();
        meta.put(SyncMeta.ULTIMA_SINCRONIZACAO, System.currentTimeMillis());
        meta.put(SyncMeta.DESVIO_RELOGIO, api.getClockSkewMs());
        meta.remove(SyncMeta.ULTIMO_ERRO);
        meta.remove(SyncMeta.BLOQUEIO_PLANO);

        // O aviso da mescla sobrevive a esta limpeza: ele explica a primeira
        // sincronização e some quando a pessoa o vê na tela de conta.
        Log.i(TAG, "sincronização concluída: " + resultado.enviadas + " enviada(s), "
                + resultado.recebidas + " recebida(s), " + resultado.conflitos + " conflito(s), "
                + resultado.recusadas + " recusada(s), " + pendentes + " na fila");

        // Operação recusada em definitivo não se resolve sozinha. O aviso fica
        // na tela de conta em vez de sumir junto com o registro do worker.
        String aviso = avisoNovo;
        if (new OutboxRepository(db).failedCount() > 0) {
            meta.put(SyncMeta.ULTIMO_ERRO,
                    "Algumas alterações não foram aceitas. Veja os detalhes na tela de conta.");
            aviso = "Algumas alterações não foram aceitas. Veja os detalhes na tela de conta.";
        }
        SyncStatus.finished(resultado.enviadas, resultado.recebidas + fotosBaixadas, aviso, pendentes);
        br.com.gameloop.estoquesimples.diagnostics.ErrorReporter.flushAsync();
        return Result.success();
    }

    static String mensagemDaRestauracao(LocalMerge.Result mescla) {
        StringBuilder texto = new StringBuilder("Cópia restaurada e conferida com a nuvem.");
        if (mescla.enviados > 0) {
            texto.append(mescla.enviados == 1
                    ? " 1 produto que só existia na cópia foi enviado."
                    : " " + mescla.enviados + " produtos que só existiam na cópia foram enviados.");
        }
        if (mescla.repetidos > 0) {
            texto.append(" Produtos repetidos (mesmo nome ou código) ficaram com a versão da nuvem.");
        }
        return texto.toString();
    }

    /** Explica, em uma frase, o que aconteceu com o que havia no aparelho. */
    static String mensagemDaMescla(LocalMerge.Result mescla) {
        StringBuilder texto = new StringBuilder("Este aparelho passou a usar o estoque da empresa na nuvem.");
        if (mescla.enviados > 0) {
            texto.append(mescla.enviados == 1
                    ? " O produto cadastrado aqui foi enviado para lá."
                    : " Os " + mescla.enviados + " produtos cadastrados aqui foram enviados para lá.");
        }
        if (mescla.repetidos > 0) {
            texto.append(mescla.repetidos == 1
                    ? " 1 produto que já existia na nuvem com o mesmo nome ou código ficou com a versão de lá."
                    : " " + mescla.repetidos + " produtos que já existiam na nuvem com o mesmo nome ou código ficaram com a versão de lá.");
        }
        texto.append(" Uma cópia do que havia aqui ficou guardada.");
        return texto.toString();
    }

    private Result handleApiFailure(Context context, ApiException e) {
        SyncStatus.failed(e.userMessage());
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
