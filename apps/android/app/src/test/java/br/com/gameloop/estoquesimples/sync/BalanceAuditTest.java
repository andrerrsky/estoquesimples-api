package br.com.gameloop.estoquesimples.sync;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Regra de quando a conferência de saldo pode rodar de novo.
 *
 * É a parte da conferência que não depende de banco nem de rede, e também a
 * mais fácil de errar: o relógio do aparelho não é confiável, e um erro aqui
 * ou faz o catálogo inteiro ser rebaixado a cada rodada, ou deixa o aparelho
 * sem nunca conferir.
 */
public class BalanceAuditTest {

    @Test
    public void naoRepeteAntesDoIntervalo() {
        long agora = 1_700_000_000_000L;
        assertFalse(BalanceAudit.estaNaHora(agora - 1_000L, agora));
        assertFalse(BalanceAudit.estaNaHora(agora - BalanceAudit.INTERVALO_MS + 1L, agora));
    }

    @Test
    public void rodaQuandoOIntervaloFecha() {
        long agora = 1_700_000_000_000L;
        assertTrue(BalanceAudit.estaNaHora(agora - BalanceAudit.INTERVALO_MS, agora));
        assertTrue(BalanceAudit.estaNaHora(0L, agora));
    }

    @Test
    public void marcaNoFuturoNaoPrendeOAparelho() {
        // Relógio adiantado e depois corrigido gravaria uma data que só
        // chegaria daqui a anos; até lá o aparelho ficaria sem conferir.
        long agora = 1_700_000_000_000L;
        assertTrue(BalanceAudit.estaNaHora(agora + 365L * 24 * 3_600_000L, agora));
    }

    @Test
    public void oAdiamentoPorBackoffEMenorQueOIntervaloCheio() {
        // O carimbo que `adiar()` grava é `agora - INTERVALO + BACKOFF`:
        // precisa segurar por BACKOFF_MS e liberar depois disso.
        long agora = 1_700_000_000_000L;
        long carimbo = agora - BalanceAudit.INTERVALO_MS + BalanceAudit.BACKOFF_MS;
        assertFalse(BalanceAudit.estaNaHora(carimbo, agora));
        assertFalse(BalanceAudit.estaNaHora(carimbo, agora + BalanceAudit.BACKOFF_MS - 1L));
        assertTrue(BalanceAudit.estaNaHora(carimbo, agora + BalanceAudit.BACKOFF_MS));
    }
}
