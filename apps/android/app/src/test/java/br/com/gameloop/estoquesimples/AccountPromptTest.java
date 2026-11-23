package br.com.gameloop.estoquesimples;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AccountPromptTest {

    @Test
    public void conviteNoPrimeiroProdutoCadastradoAgora() {
        assertTrue(AccountPrompt.deveConvidar(1, true, false, false, true, true));
    }

    @Test
    public void naoConvidaSoPorAbrirATela() {
        assertFalse(AccountPrompt.deveConvidar(1, false, false, false, true, true));
    }

    @Test
    public void naoConvidaQuemJaTemConta() {
        assertFalse(AccountPrompt.deveConvidar(1, true, true, false, true, true));
    }

    @Test
    public void naoRepeteOConvite() {
        assertFalse(AccountPrompt.deveConvidar(1, true, false, true, true, true));
    }

    @Test
    public void naoConvidaNoSegundoProduto() {
        assertFalse(AccountPrompt.deveConvidar(2, true, false, false, true, true));
    }

    @Test
    public void servidorPodeDesligar() {
        assertFalse(AccountPrompt.deveConvidar(1, true, false, false, false, true));
    }

    @Test
    public void foraDaFatiaNaoVeOConvite() {
        assertFalse(AccountPrompt.deveConvidar(1, true, false, false, true, false));
    }

    @Test
    public void fatiaZeroEFatiaCheia() {
        assertFalse(AccountPrompt.noExperimento("qualquer-aparelho", 0));
        assertTrue(AccountPrompt.noExperimento("qualquer-aparelho", 100));
        assertTrue(AccountPrompt.noExperimento(null, 100));
    }

    @Test
    public void semIdentificadorFicaDeFora() {
        assertFalse(AccountPrompt.noExperimento(null, 50));
        assertFalse(AccountPrompt.noExperimento("", 50));
    }

    /** O mesmo aparelho não pode trocar de grupo entre uma abertura e outra. */
    @Test
    public void sorteioEstavelPorInstalacao() {
        String id = "3f0c2b16-9d41-4a88-8f55-6c0d9a21bb07";
        boolean primeira = AccountPrompt.noExperimento(id, 50);
        for (int i = 0; i < 50; i++) {
            assertEquals(primeira, AccountPrompt.noExperimento(id, 50));
        }
    }

    /** Metade da base, mais ou menos: o sorteio não pode pender para um lado. */
    @Test
    public void metadeDaBaseEntraComCinquentaPorCento() {
        int dentro = 0;
        int total = 2000;
        for (int i = 0; i < total; i++) {
            if (AccountPrompt.noExperimento("instalacao-" + i + "-estoque", 50)) {
                dentro++;
            }
        }
        assertTrue("fatia inesperada: " + dentro, dentro > total * 0.4 && dentro < total * 0.6);
    }
}
