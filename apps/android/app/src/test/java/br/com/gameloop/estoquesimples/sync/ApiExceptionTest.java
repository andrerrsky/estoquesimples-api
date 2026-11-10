package br.com.gameloop.estoquesimples.sync;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ApiExceptionTest {

    @Test
    public void contaBloqueadaNoLoginExplicaEPedeSuporte() {
        ApiException e = new ApiException(403, ApiException.CONTA_BLOQUEADA, "Conta suspensa.", null);
        assertTrue(e.isAccountBlocked());
        assertFalse(e.needsReauth());
        assertTrue(e.userMessage().contains("bloqueada"));
        assertTrue(e.userMessage().contains("suporte"));
    }

    @Test
    public void contaBloqueadaComSessaoAbertaEncerraASessao() {
        ApiException e = new ApiException(401, ApiException.CONTA_BLOQUEADA, "Conta suspensa.", null);
        assertTrue(e.needsReauth());
        assertTrue(e.userMessage().contains("bloqueada"));
    }

    @Test
    public void sessaoExpiradaContinuaComAMensagemDeSempre() {
        ApiException e = new ApiException(401, "AUTH_SESSION_REVOKED", "Sessão encerrada.", null);
        assertFalse(e.isAccountBlocked());
        assertTrue(e.userMessage().contains("sessão expirou"));
    }
}
