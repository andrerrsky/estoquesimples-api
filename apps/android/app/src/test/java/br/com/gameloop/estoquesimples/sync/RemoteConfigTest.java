package br.com.gameloop.estoquesimples.sync;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Trégua da atualização obrigatória.
 *
 * Quem não consegue atualizar não pode perder o acesso ao próprio estoque,
 * que está no aparelho. Mas a trégua também não pode virar bloqueio desligado
 * para sempre — que é o que aconteceria num aparelho com a data errada se a
 * conta fosse feita sobre uma data de validade guardada.
 */
public class RemoteConfigTest {

    private static final long AGORA = 1_700_000_000_000L;

    @Test
    public void semTreguaConcedidaOBloqueioVale() {
        assertFalse(RemoteConfig.emTregua(0L, AGORA));
        assertFalse(RemoteConfig.emTregua(-1L, AGORA));
    }

    @Test
    public void aTreguaValePeloPrazoEDepoisAcaba() {
        assertTrue(RemoteConfig.emTregua(AGORA, AGORA));
        assertTrue(RemoteConfig.emTregua(AGORA, AGORA + RemoteConfig.TREGUA_MS - 1L));
        assertFalse(RemoteConfig.emTregua(AGORA, AGORA + RemoteConfig.TREGUA_MS));
    }

    @Test
    public void relogioAdiantadoNaConcessaoNaoLiberaOAppPorAnos() {
        // Trégua concedida com o relógio um ano à frente: depois que o
        // aparelho acerta a data, ela deixa de valer na hora.
        long concedidaNoFuturo = AGORA + 365L * 24 * 3_600_000L;
        assertFalse(RemoteConfig.emTregua(concedidaNoFuturo, AGORA));
    }
}
