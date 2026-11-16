package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Fechamento da conferência de estoque.
 *
 * O que está sob teste aqui não é um relatório: é a lista de produtos que vão
 * ter a quantidade **alterada** no estoque de alguém. A regra mais importante
 * — item não conferido nunca vira zero — tem teste próprio porque o erro
 * oposto destrói dados reais e é irreversível na prática.
 */
public class ConferenceSummaryTest {

    private static ConferenceRepository.Item item(String name, double expected,
                                                  Double counted, double cost) {
        return new ConferenceRepository.Item("uuid-" + name, name, "un", expected, cost, counted);
    }

    @Test
    public void naoConferidoNaoEntraNaConta() {
        List<ConferenceRepository.Item> items = Arrays.asList(
                item("parafuso", 100d, null, 2d),
                item("porca", 50d, null, 1d));

        ConferenceRepository.Summary summary = ConferenceRepository.Summary.of(items);

        assertEquals(2, summary.inScope);
        assertEquals(0, summary.counted);
        assertEquals(0, summary.divergent);
        assertEquals(2, summary.notCounted());
        assertEquals(0d, summary.missingValue, 0.0001);
        assertEquals(0d, summary.extraValue, 0.0001);
        assertTrue("nada a ajustar quando nada foi contado", summary.divergentItems.isEmpty());
    }

    @Test
    public void naoConferidoNaoViraZero() {
        // O caso que destrói estoque: 100 no sistema, a pessoa não contou.
        // Se "não contado" fosse lido como zero, isto apareceria como uma
        // falta de R$ 200 e o fechamento zeraria o produto.
        ConferenceRepository.Item naoContado = item("parafuso", 100d, null, 2d);

        assertFalse(naoContado.isCounted());
        assertFalse(naoContado.isDivergent());
        assertEquals(0d, naoContado.delta(), 0.0001);
        assertEquals(0d, naoContado.deltaValue(), 0.0001);
    }

    @Test
    public void contadoZeroEhDivergenciaDeVerdade() {
        // Contar e achar zero é diferente de não contar: aqui o ajuste deve
        // mesmo acontecer.
        ConferenceRepository.Item contadoZero = item("parafuso", 100d, 0d, 2d);

        assertTrue(contadoZero.isCounted());
        assertTrue(contadoZero.isDivergent());
        assertEquals(-100d, contadoZero.delta(), 0.0001);
        assertEquals(-200d, contadoZero.deltaValue(), 0.0001);
    }

    @Test
    public void somaFaltaESobraSeparadamente() {
        List<ConferenceRepository.Item> items = Arrays.asList(
                item("central", 64d, 60d, 100d),      // faltam 4 × 100 = 400
                item("arame", 7d, 9d, 25d),           // sobram 2 × 25 = 50
                item("ac800", 7d, 7d, 30d),           // conferido, sem diferença
                item("ac1000", 5d, null, 40d));       // não conferido

        ConferenceRepository.Summary summary = ConferenceRepository.Summary.of(items);

        assertEquals(4, summary.inScope);
        assertEquals(3, summary.counted);
        assertEquals(1, summary.notCounted());
        assertEquals(2, summary.divergent);
        assertEquals(400d, summary.missingValue, 0.0001);
        assertEquals(50d, summary.extraValue, 0.0001);
        // O número que vai para a tela: negativo quando falta mercadoria.
        assertEquals(-350d, summary.netValue(), 0.0001);
    }

    @Test
    public void conferidoSemDiferencaNaoGeraAjuste() {
        List<ConferenceRepository.Item> items = new ArrayList<>();
        items.add(item("central", 64d, 64d, 100d));

        ConferenceRepository.Summary summary = ConferenceRepository.Summary.of(items);

        assertEquals(1, summary.counted);
        assertEquals(0, summary.divergent);
        assertEquals(0d, summary.netValue(), 0.0001);
        assertTrue(summary.divergentItems.isEmpty());
    }

    @Test
    public void produtoSemCustoNaoQuebraOTotal() {
        // Sem custo nem preço, a diferença de quantidade continua valendo,
        // só não soma dinheiro — melhor que travar o fechamento.
        List<ConferenceRepository.Item> items = Arrays.asList(
                item("sem preço", 10d, 4d, 0d),
                item("com preço", 10d, 4d, 5d));

        ConferenceRepository.Summary summary = ConferenceRepository.Summary.of(items);

        assertEquals(2, summary.divergent);
        assertEquals(30d, summary.missingValue, 0.0001);
    }

    @Test
    public void quantidadeFracionariaSeComporta() {
        // Quantidade é fracionária desde a versão 3 do banco local (quem vende
        // por metro ou por quilo).
        List<ConferenceRepository.Item> items = Arrays.asList(
                item("cabo", 12.5d, 11.25d, 8d));

        ConferenceRepository.Summary summary = ConferenceRepository.Summary.of(items);

        assertEquals(1, summary.divergent);
        assertEquals(10d, summary.missingValue, 0.0001);
    }
}
