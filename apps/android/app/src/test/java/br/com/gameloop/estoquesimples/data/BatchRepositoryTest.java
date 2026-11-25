package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * A regra que decide o que ainda está na prateleira. Errar aqui some do
 * estoque mercadoria que existe, ou mantém nele o que já saiu.
 */
public class BatchRepositoryTest {

    private static BatchRepository.Entrada entrada(String code, String validade, double total) {
        return new BatchRepository.Entrada(code, null, validade, total);
    }

    @Test
    public void saldoFicaComOsLotesQueVencemDepois() {
        // Na ordem de permanência: o que vence por último recebe primeiro,
        // porque o que vence antes já saiu (FEFO).
        List<BatchRepository.Entrada> entradas = Arrays.asList(
                entrada("L3", "2027-03-15", 30),
                entrada("L1", "2026-12-02", 10),
                entrada("L2", "2026-11-20", 5));

        // Saldo 35: o lote que vence primeiro é o que faltou.
        assertArrayEquals(new double[]{30, 5, 0}, BatchRepository.alocar(35, entradas), 0.0001);
    }

    @Test
    public void somaDosLotesNuncaPassaDoSaldoDoProduto() {
        List<BatchRepository.Entrada> entradas = Arrays.asList(
                entrada("A", "2027-01-01", 10),
                entrada("B", "2026-12-01", 10));

        // Entraram 20, saíram 18: sobra 2, no lote de validade mais distante.
        assertArrayEquals(new double[]{2, 0}, BatchRepository.alocar(2, entradas), 0.0001);
        // Saldo zero não deixa lote nenhum em pé.
        assertArrayEquals(new double[]{0, 0}, BatchRepository.alocar(0, entradas), 0.0001);
    }

    @Test
    public void saldoMaiorQueOsLotesSobraForaDeles() {
        List<BatchRepository.Entrada> entradas = Collections.singletonList(
                entrada("F-9", "2027-02-10", 4));

        // Produto com 8 em estoque e um lote de 4: o resto entrou sem lote e
        // não pode ser inventado dentro dele.
        double[] saldos = BatchRepository.alocar(8, entradas);
        assertEquals(4, saldos[0], 0.0001);
    }

    @Test
    public void diasAteVencer() {
        assertEquals(Integer.valueOf(0), Dias.entre("2026-11-25", "2026-11-25"));
        assertEquals(Integer.valueOf(1), Dias.entre("2026-11-25", "2026-11-26"));
        assertEquals(Integer.valueOf(-5), Dias.entre("2026-11-25", "2026-11-20"));
        // Fim de mês e ano viram sem truque de aritmética de dias.
        assertEquals(Integer.valueOf(37), Dias.entre("2026-11-25", "2027-01-01"));
        assertNull(Dias.entre("2026-11-25", null));
        assertEquals("02/12/2026", Dias.legivel("2026-12-02"));
        assertEquals("", Dias.legivel(null));
    }

    @Test
    public void loteVazioNaoVira() {
        assertNull(Batch.orNull(null, null, null));
        assertNull(Batch.orNull("   ", "", null));
        Batch batch = Batch.orNull(" L1 ", null, "2027-01-31");
        assertEquals("L1", batch.code);
        assertEquals("2027-01-31", batch.expiresOn);
        assertNull(batch.manufacturedOn);
    }
}
