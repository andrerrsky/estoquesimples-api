package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ProfitSummaryTest {

    @Test
    public void somaCustoELucroSoDosProdutosComCusto() {
        ProfitSummary s = new ProfitSummary();
        s.addProduct(10, 20, 12.0);   // lucro 80, venda 200
        s.addProduct(5, 10, null);    // sem custo: fora da conta
        s.addProduct(-2, 30, 10.0);   // saldo negativo não vira estoque
        assertEquals(120, s.stockAtCost, 1e-9);
        assertEquals(80, s.potentialProfit, 1e-9);
        assertEquals(Long.valueOf(40), s.potentialMarginPercent());
        assertEquals(2, s.productsWithCost);
        assertEquals(1, s.productsWithoutCost);
        assertTrue(s.hasAnyCost());
    }

    @Test
    public void lucroDasSaidasUsaModuloEPulaSemCusto() {
        ProfitSummary s = new ProfitSummary();
        s.addExit(-3, 20, 12.0);
        s.addExit(2, 15, null);
        assertEquals(24, s.exitsProfit, 1e-9);
        assertEquals(60, s.exitsRevenueWithCost, 1e-9);
        assertEquals(1, s.exitsWithoutCost);
        assertEquals(Long.valueOf(40), s.exitsMarginPercent());
    }

    @Test
    public void semCustoNenhumNaoInventaMargem() {
        ProfitSummary s = new ProfitSummary();
        s.addProduct(4, 10, null);
        assertFalse(s.hasAnyCost());
        assertNull(s.potentialMarginPercent());
    }

    @Test
    public void custoVazioENaoInformado() {
        assertNull(Product.costOf(null));
        assertNull(Product.costOf("  "));
        assertEquals(0d, Product.costOf("0"), 1e-9);
        assertEquals(12.5d, Product.costOf("12.5"), 1e-9);
    }
}
