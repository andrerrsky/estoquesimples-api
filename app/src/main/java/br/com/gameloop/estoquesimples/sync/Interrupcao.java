package br.com.gameloop.estoquesimples.sync;

/**
 * Sinal de parada cooperativa para laços longos de sincronização.
 *
 * O WorkManager pode pedir que o worker pare a qualquer momento. Em vez de
 * deixar a interrupção cair no meio de um lote sem registro, o motor consulta
 * este sinal no topo de cada página e sai com um código recuperável.
 */
public interface Interrupcao {
    boolean pediuParada();
}
