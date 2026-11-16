package br.com.gameloop.estoquesimples;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * A regra que decide se o texto buscado na ajuda pode virar evento. Tem
 * teste porque é regra de privacidade: se ela afrouxar sem querer, dado de
 * cliente começa a sair do aparelho sem ninguém perceber. Mesmos casos da
 * web (apps/web/tests/help-search-term.test.ts).
 */
public class HelpSearchTermTest {

    @Test
    public void normalizaEspacosECaixa() {
        assertEquals("como fazer backup", HelpActivity.termoDeBusca("  Como fazer   BACKUP "));
    }

    @Test
    public void guardaDuvidaReal() {
        assertEquals("como convidar funcionário", HelpActivity.termoDeBusca("como convidar funcionário"));
    }

    @Test
    public void descartaEmail() {
        assertNull(HelpActivity.termoDeBusca("maria@exemplo.com.br"));
    }

    @Test
    public void descartaTelefoneEDocumento() {
        assertNull(HelpActivity.termoDeBusca("11 98765-4321"));
        assertNull(HelpActivity.termoDeBusca("123.456.789-00"));
    }

    @Test
    public void descartaEnderecoWeb() {
        assertNull(HelpActivity.termoDeBusca("https://exemplo.com"));
    }

    @Test
    public void deixaPassarNumeroCurto() {
        assertEquals("limite de 50 produtos", HelpActivity.termoDeBusca("limite de 50 produtos"));
    }

    @Test
    public void descartaTextoColado() {
        StringBuilder longo = new StringBuilder();
        for (int i = 0; i < 61; i++) longo.append('a');
        assertNull(HelpActivity.termoDeBusca(longo.toString()));
    }

    @Test
    public void descartaVazioELetraSolta() {
        assertNull(HelpActivity.termoDeBusca("   "));
        assertNull(HelpActivity.termoDeBusca("a"));
        assertNull(HelpActivity.termoDeBusca(null));
    }
}
