package br.com.gameloop.estoquesimples.changelog;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.Collections;

public class ReleaseTest {

    private static Release release(String date) {
        return new Release(40, date, "Lote e validade",
                Collections.singletonList("Novidade"), Collections.<String>emptyList());
    }

    @Test
    public void dataSaiNoFormatoQueOBrasilLe() {
        assertEquals("25/11/2026", release("2026-11-25").dataLegivel());
        // Dia de calendário, não instante: sem Date no meio, o fuso do
        // aparelho não muda o dia mostrado.
        assertEquals("01/01/2026", release("2026-01-01").dataLegivel());
    }

    @Test
    public void dataAusenteNaoQuebraATela() {
        assertEquals("", release(null).dataLegivel());
        assertEquals("", release("2026-11").dataLegivel());
    }
}
