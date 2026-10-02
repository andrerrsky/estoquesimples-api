package br.com.gameloop.estoquesimples;

/** Plural em português sem "produto(s)": "1 produto", "6 produtos". */
public final class Texto {

    private Texto() {
    }

    public static String plural(long n, String singular, String pluralForm) {
        return n + " " + (n == 1 ? singular : pluralForm);
    }

    public static String plural(double n, String singular, String pluralForm) {
        return CurrencyHelper.formatQuantity(n) + " " + (n == 1 ? singular : pluralForm);
    }
}
