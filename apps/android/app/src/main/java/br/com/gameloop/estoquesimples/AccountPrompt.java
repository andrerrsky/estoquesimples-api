package br.com.gameloop.estoquesimples;

/**
 * Quando convidar a criar conta depois do primeiro produto cadastrado à mão.
 *
 * O que a medição mostrou: 321 pessoas salvam o primeiro produto, 46 importam
 * planilha e só 66 criam conta — e quem tem pelo menos um produto volta no dia
 * seguinte 4 vezes mais (40% contra 9,5%). O convite que existia (o aviso na
 * lista) só aparece a partir de 5 produtos, e 63% das instalações usam o app
 * num único dia: a maioria nunca chega lá. Então o momento certo é o primeiro
 * produto, que é quando a pessoa acabou de criar algo que ela não quer perder.
 *
 * Vale como experimento, não como certeza: entra uma fatia da base
 * ({@code percentual}, hoje metade), o sorteio é estável por instalação para o
 * mesmo aparelho não trocar de lado a cada abertura, e o servidor pode
 * desligar tudo sem publicar versão nova (bloco {@code experiments} de
 * {@code /v1/config}).
 *
 * Classe pura para ser testada: o projeto não tem Robolectric.
 */
public final class AccountPrompt {

    private AccountPrompt() {
    }

    /** Produtos a partir dos quais o convite faz sentido. */
    public static final int PRIMEIRO_PRODUTO = 1;

    /**
     * De que lado do experimento este aparelho está.
     *
     * Hash estável do identificador da instalação: nada de sorteio a cada
     * abertura, que faria a mesma pessoa ver o convite num dia e não no
     * outro — e tornaria a comparação entre os dois grupos inútil.
     */
    public static boolean noExperimento(String installId, int percentual) {
        if (percentual <= 0) {
            return false;
        }
        if (percentual >= 100) {
            return true;
        }
        if (installId == null || installId.isEmpty()) {
            // Sem identificador não há sorteio estável; fica fora, para não
            // misturar um grupo instável na medição.
            return false;
        }
        int balde = Math.abs(installId.hashCode() % 100);
        return balde < percentual;
    }

    /**
     * @param produtos         quantos produtos a lista tem agora
     * @param acabouDeCadastrar a pessoa chegou aqui salvando um produto
     * @param temConta          já entrou numa conta (nada a convidar)
     * @param jaConvidado       este convite já apareceu neste aparelho
     * @param experimentoAtivo  o servidor mantém o experimento ligado
     * @param noExperimento     este aparelho está na fatia que vê o convite
     */
    public static boolean deveConvidar(int produtos, boolean acabouDeCadastrar, boolean temConta,
                                       boolean jaConvidado, boolean experimentoAtivo,
                                       boolean noExperimento) {
        return acabouDeCadastrar
                && produtos == PRIMEIRO_PRODUTO
                && !temConta
                && !jaConvidado
                && experimentoAtivo
                && noExperimento;
    }
}
