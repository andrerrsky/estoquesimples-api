package br.com.gameloop.estoquesimples.data;

import br.com.gameloop.estoquesimples.CurrencyHelper;

/**
 * Conversão entre a quantidade exibida e a armazenada.
 *
 * Delega ao {@code CurrencyHelper}, que já trata vírgula como separador
 * decimal e outras particularidades do formato brasileiro. Existe como camada
 * separada para que o código de dados não dependa de uma classe de
 * apresentação, e para concentrar num único ponto a futura mudança do campo
 * para tipo numérico.
 */
public final class Quantities {

    private Quantities() {
    }

    public static double parse(String stored) {
        return CurrencyHelper.parseCurrency(stored, 0d);
    }

    public static double parse(String stored, double fallback) {
        return CurrencyHelper.parseCurrency(stored, fallback);
    }

    public static String forStorage(double quantity) {
        return CurrencyHelper.quantityForStorage(quantity);
    }
}
