package br.com.gameloop.estoquesimples.analytics;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Map;

import org.junit.Test;

public class InstallAttributionTest {

    @Test
    public void organicoDaLoja() {
        Map<String, String> values = InstallAttribution.parse("utm_source=google-play&utm_medium=organic");
        assertEquals("google-play", values.get("utm_source"));
        assertEquals("organic", values.get("utm_medium"));
        assertFalse(InstallAttribution.hasClickId(values));
    }

    @Test
    public void anuncioDoGoogleGuardaClique() {
        Map<String, String> values = InstallAttribution.parse(
                "gclid=EAIaIQobChMI-abc_1.2&utm_source=google&utm_medium=cpc&utm_campaign=app%20instalacoes&anid=admob");
        assertEquals("EAIaIQobChMI-abc_1.2", values.get("gclid"));
        assertEquals("app instalacoes", values.get("utm_campaign"));
        assertFalse(values.containsKey("anid"));
        assertTrue(InstallAttribution.hasClickId(values));
    }

    @Test
    public void descartaValoresForaDoFormato() {
        Map<String, String> values = InstallAttribution.parse(
                "utm_source=fulano%40exemplo.com&gclid=abc%20def&utm_medium=&utm_content=ok&email=x");
        assertEquals(1, values.size());
        assertEquals("ok", values.get("utm_content"));
    }

    @Test
    public void vazioOuNulo() {
        assertTrue(InstallAttribution.parse(null).isEmpty());
        assertTrue(InstallAttribution.parse("").isEmpty());
        assertTrue(InstallAttribution.parse("sem-igual").isEmpty());
    }
}
