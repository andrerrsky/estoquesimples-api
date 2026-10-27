package br.com.gameloop.estoquesimples.sync;

import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Estado ao vivo da sincronização, para as telas darem retorno: a barra fina
 * no topo da lista enquanto roda, o botão "Sincronizando…" na tela de conta e
 * o resumo quando termina.
 *
 * O worker roda no mesmo processo do app, então um estado em memória basta:
 * quem estiver olhando recebe os avisos na thread principal. Com o app
 * fechado não há ninguém para avisar, e o resultado fica no banco
 * (última sincronização, avisos) como sempre.
 */
public final class SyncStatus {

    public interface Listener {
        void onSyncChanged(Snapshot snapshot);
    }

    public static final class Snapshot {
        public final boolean running;
        /** A rodada foi pedida por um toque da pessoa (mostra o resumo ao terminar). */
        public final boolean requestedByUser;
        public final int enviadas;
        public final int recebidas;
        /** Mensagem de erro da última rodada; nula quando deu certo. */
        public final String erro;
        /** Algo para contar à pessoa mesmo com sucesso (primeira sincronização). */
        public final String aviso;
        public final long finishedAt;
        /** Alterações feitas aqui que ainda não subiram (o número no ícone da barra). */
        public final int pendentes;

        Snapshot(boolean running, boolean requestedByUser, int enviadas, int recebidas,
                 String erro, String aviso, long finishedAt, int pendentes) {
            this.running = running;
            this.requestedByUser = requestedByUser;
            this.enviadas = enviadas;
            this.recebidas = recebidas;
            this.erro = erro;
            this.aviso = aviso;
            this.finishedAt = finishedAt;
            this.pendentes = pendentes;
        }

        Snapshot withPendentes(int valor) {
            return new Snapshot(running, requestedByUser, enviadas, recebidas, erro, aviso, finishedAt, valor);
        }
    }

    private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile Snapshot current = new Snapshot(false, false, 0, 0, null, null, 0L, 0);
    private static volatile boolean pedidoPeloUsuario;
    /** Quando a última rodada começou ou terminou (para não repetir ao voltar ao app). */
    private static volatile long ultimaAtividade;

    private SyncStatus() {
    }

    public static Snapshot current() {
        return current;
    }

    /** A pessoa tocou em sincronizar: a próxima rodada mostra o resumo. */
    public static void markRequestedByUser() {
        pedidoPeloUsuario = true;
    }

    /** Instante da última rodada (início ou fim); zero se nenhuma rodou neste processo. */
    public static long lastActivityAt() {
        return ultimaAtividade;
    }

    /**
     * Tamanho atual da fila de saída. Chamado por quem acabou de enfileirar
     * (a fila cresceu) e pelo worker ao terminar (a fila esvaziou).
     */
    public static void setPendentes(int pendentes) {
        if (current.pendentes != pendentes) {
            publish(current.withPendentes(pendentes));
        }
    }

    static void started() {
        ultimaAtividade = System.currentTimeMillis();
        publish(new Snapshot(true, pedidoPeloUsuario, 0, 0, null, null, 0L, current.pendentes));
    }

    static void finished(int enviadas, int recebidas, String aviso, int pendentes) {
        boolean pedido = pedidoPeloUsuario;
        pedidoPeloUsuario = false;
        ultimaAtividade = System.currentTimeMillis();
        publish(new Snapshot(false, pedido, enviadas, recebidas, null, aviso, ultimaAtividade, pendentes));
    }

    static void failed(String erro) {
        boolean pedido = pedidoPeloUsuario;
        pedidoPeloUsuario = false;
        ultimaAtividade = System.currentTimeMillis();
        publish(new Snapshot(false, pedido, 0, 0, erro, null, ultimaAtividade, current.pendentes));
    }

    private static void publish(Snapshot snapshot) {
        current = snapshot;
        MAIN.post(() -> {
            for (Listener listener : LISTENERS) {
                listener.onSyncChanged(snapshot);
            }
        });
    }

    public static void addListener(Listener listener) {
        LISTENERS.addIfAbsent(listener);
    }

    public static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }

    /** Resumo de uma rodada terminada, em uma frase. */
    public static String summary(Snapshot snapshot) {
        if (snapshot.erro != null) {
            return snapshot.erro;
        }
        if (snapshot.aviso != null) {
            return snapshot.aviso;
        }
        if (snapshot.enviadas == 0 && snapshot.recebidas == 0) {
            return "Tudo sincronizado. Nada de novo por aqui.";
        }
        StringBuilder texto = new StringBuilder("Sincronizado:");
        if (snapshot.enviadas > 0) {
            texto.append(' ').append(snapshot.enviadas)
                    .append(snapshot.enviadas == 1 ? " alteração enviada" : " alterações enviadas");
        }
        if (snapshot.recebidas > 0) {
            if (snapshot.enviadas > 0) texto.append(" e");
            texto.append(' ').append(snapshot.recebidas)
                    .append(snapshot.recebidas == 1 ? " recebida" : " recebidas");
        }
        return texto.append('.').toString();
    }
}
