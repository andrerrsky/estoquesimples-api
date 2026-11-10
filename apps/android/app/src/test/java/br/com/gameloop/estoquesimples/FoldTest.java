package br.com.gameloop.estoquesimples;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** Busca sem acento da tela principal (ANR da versão 29). */
public class FoldTest {

    @Test
    public void removeAcentoEPoeEmMinusculas() {
        assertEquals("oleo de soja", MainActivity.fold("  Óleo de Soja "));
        assertEquals("acucar cristal", MainActivity.fold("AÇÚCAR Cristal"));
        assertEquals("7891234567890", MainActivity.fold("7891234567890"));
        assertEquals("sku-abc", MainActivity.fold("SKU-ABC"));
        assertEquals("", MainActivity.fold(null));
    }

    @Test
    public void duzentasMilChamadasEmPoucoTempo() {
        long inicio = System.nanoTime();
        for (int i = 0; i < 200_000; i++) {
            MainActivity.fold(i % 2 == 0 ? "Pão de Queijo " + i : "Arroz 5kg " + i);
        }
        long ms = (System.nanoTime() - inicio) / 1_000_000;
        assertTrue("fold lento: " + ms + "ms", ms < 3_000);
    }
}
