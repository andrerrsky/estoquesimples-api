package br.com.gameloop.estoquesimples.data;

/**
 * Chave geral da fila de saída.
 *
 * Os repositórios precisam saber se vale a pena enfileirar uma operação, mas
 * não deveriam conhecer sessão, assinatura ou configuração remota. Este
 * interruptor é a única coisa que atravessa: quem entende dessas regras o
 * atualiza, e a camada de dados só lê.
 *
 * Começa desligado. Enquanto o usuário não entrar numa conta, nada é
 * enfileirado — a fila existiria só para ser descartada, já que a primeira
 * sincronização envia o banco inteiro de qualquer forma.
 *
 * <p><b>São duas perguntas, não uma.</b> "Este aparelho sincroniza?" e "estou
 * neste instante aplicando o que veio da nuvem?" já foram o mesmo booleano, e
 * a confusão custava dados: bastava a sincronização desligar o interruptor
 * durante uma leitura para que tudo o que o usuário digitasse naquela janela
 * fosse gravado no SQLite sem operação correspondente na fila — salvo na tela,
 * invisível para a nuvem, para sempre.
 *
 * <p>{@link #isActive()} responde só a primeira, e é ligada por ter sessão e
 * empresa escolhida. Perder a assinatura ou tomar um 403 <b>não</b> a desliga:
 * a fila é justamente o registro do que precisa subir quando o acesso voltar;
 * o que para são as tentativas de rede. A segunda pergunta é
 * {@link #isApplyingRemote()}, marcada por thread, então ela nunca alcança a
 * thread principal onde o usuário digita.
 */
public final class SyncGate {

    private static volatile boolean active;

    /**
     * Marcada apenas na thread que está gravando o que chegou do servidor.
     *
     * Precisa ser por thread, e não global: a sincronização roda em segundo
     * plano enquanto a pessoa continua mexendo no estoque, e uma marca global
     * suprimiria também as alterações dela.
     */
    private static final ThreadLocal<Boolean> applyingRemote = new ThreadLocal<>();

    private SyncGate() {
    }

    public static boolean isActive() {
        return active;
    }

    public static void setActive(boolean value) {
        active = value;
    }

    /**
     * Liga ou desliga a supressão nesta thread. Sempre em try/finally, e só na
     * thread da sincronização.
     */
    public static void suppressForRemoteApply(boolean value) {
        if (value) {
            applyingRemote.set(Boolean.TRUE);
        } else {
            applyingRemote.remove();
        }
    }

    public static boolean isApplyingRemote() {
        return Boolean.TRUE.equals(applyingRemote.get());
    }

    /**
     * Resposta única para os repositórios: esta gravação precisa virar
     * operação na fila?
     *
     * O que veio da nuvem não vira: reenviá-lo seria devolver ao servidor o que
     * ele acabou de mandar. Tudo o mais que é gravado com o aparelho
     * configurado para sincronizar vira, sem exceção.
     */
    public static boolean shouldEnqueue() {
        return active && !isApplyingRemote();
    }
}
