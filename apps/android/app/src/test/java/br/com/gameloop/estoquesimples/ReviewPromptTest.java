package br.com.gameloop.estoquesimples;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ReviewPromptTest {

    private static final long DIA = 24L * 3_600_000L;

    @Test
    public void soDepoisDeTresDiasEDezMovimentacoes() {
        long agora = 100 * DIA;
        assertTrue(ReviewPrompt.eligible(agora - 3 * DIA, agora, 10));
        assertFalse(ReviewPrompt.eligible(agora - 2 * DIA, agora, 50));
        assertFalse(ReviewPrompt.eligible(agora - 30 * DIA, agora, 9));
    }
}
