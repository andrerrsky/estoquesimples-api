package br.com.gameloop.estoquesimples.data;

/**
 * Lote da mercadoria que entrou: código, fabricação e validade.
 *
 * Não é entidade: é o que a entrada contou, guardado na própria movimentação.
 * O saldo de cada lote é conta (o que vence antes sai antes), nunca cadastro
 * — a mesma decisão do servidor, pelo mesmo motivo: duas verdades sobre o
 * estoque divergem na primeira sincronização com conflito.
 *
 * As datas são dia de calendário em {@code YYYY-MM-DD}. Validade impressa no
 * pacote não tem hora nem fuso; guardá-la como instante faria o lote vencer
 * um dia antes para quem viajasse.
 */
public final class Batch {

    public final String code;
    public final String manufacturedOn;
    public final String expiresOn;

    public Batch(String code, String manufacturedOn, String expiresOn) {
        this.code = limpar(code);
        this.manufacturedOn = limpar(manufacturedOn);
        this.expiresOn = limpar(expiresOn);
    }

    /** Nada preenchido: a entrada é comum e não entra nas contas de validade. */
    public boolean isEmpty() {
        return code == null && manufacturedOn == null && expiresOn == null;
    }

    /** `null` quando não há nada a guardar, para o chamador não precisar checar. */
    public static Batch orNull(String code, String manufacturedOn, String expiresOn) {
        Batch batch = new Batch(code, manufacturedOn, expiresOn);
        return batch.isEmpty() ? null : batch;
    }

    private static String limpar(String valor) {
        if (valor == null) {
            return null;
        }
        String texto = valor.trim();
        return texto.isEmpty() ? null : texto;
    }
}
