package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * O acerto de abertura só funciona se a soma do histórico for calculada com a
 * mesma convenção de sinal que a nuvem usa. Estes testes fixam essa conta: é
 * ela que decide quanto falta registrar para o histórico explicar o saldo.
 */
public class OpeningBalanceTest {

    /** Soma de um histórico, como a consulta de {@link OpeningBalance} faz. */
    private static double somar(String[] tipos, double[] quantidades) {
        double total = 0d;
        for (int i = 0; i < tipos.length; i++) {
            total += MovementRepository.signedQuantity(tipos[i], quantidades[i]);
        }
        return total;
    }

    @Test
    public void historicoCompletoNaoGeraAjuste() {
        double somado = somar(
                new String[]{MovementRepository.CADASTRO, MovementRepository.ENTRADA, MovementRepository.SAIDA},
                new double[]{5, 10, 3});
        assertEquals(12d, somado, 0.0001d);
        assertFalse(OpeningBalance.worthAdjusting(12d - somado));
    }

    @Test
    public void historicoIncompletoGeraADiferenca() {
        // O caso real: o aparelho mostra 12, mas só o cadastro de 5 subiu.
        double somado = somar(new String[]{MovementRepository.CADASTRO}, new double[]{5});
        double delta = 12d - somado;
        assertEquals(7d, delta, 0.0001d);
        assertTrue(OpeningBalance.worthAdjusting(delta));
    }

    @Test
    public void saldoMenorQueOHistoricoGeraAjusteNegativo() {
        double somado = somar(
                new String[]{MovementRepository.CADASTRO, MovementRepository.ENTRADA},
                new double[]{5, 10});
        double delta = 4d - somado;
        assertEquals(-11d, delta, 0.0001d);
        assertTrue(OpeningBalance.worthAdjusting(delta));
    }

    @Test
    public void tiposLegadosEComSinalSomamCerto() {
        // "venda" é saída antiga; ajuste, edição e cancelamento guardam sinal.
        double somado = somar(
                new String[]{"CADASTRO", "venda", MovementRepository.EDICAO, MovementRepository.AJUSTE,
                        MovementRepository.CANCELAMENTO},
                new double[]{20, 5, -3, 2, 5});
        assertEquals(19d, somado, 0.0001d);
    }

    @Test
    public void diferencaMinusculaNaoViraLinhaNoHistorico() {
        assertFalse(OpeningBalance.worthAdjusting(0d));
        assertFalse(OpeningBalance.worthAdjusting(0.00001d));
        assertTrue(OpeningBalance.worthAdjusting(0.001d));
        assertTrue(OpeningBalance.worthAdjusting(-0.5d));
    }
}
