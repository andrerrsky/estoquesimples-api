package br.com.gameloop.estoquesimples;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Regras sobre a unidade do produto. "Leite Integral 1L" é contado por
 * unidade: uma saída de "1,5 un" (deslize na vírgula do teclado) espalhava
 * uma fração por card, chips, Relatórios e PDF — o tipo de número que faz o
 * dono desconfiar do app. Unidades de contagem não aceitam fração.
 */
public final class Unidades {

    private static final Set<String> INTEIRAS = new HashSet<>(Arrays.asList(
            "un", "und", "unid", "unidade", "unidades", "pc", "pç", "peça", "pecas", "peças",
            "pct", "pacote", "pacotes", "cx", "caixa", "caixas", "dz", "dúzia", "duzia", "dúzias",
            "sc", "saco", "sacos", "pote", "potes", "fardo", "fardos", "par", "pares", "rolo", "rolos",
            "lata", "latas", "garrafa", "garrafas", "frasco", "frascos", "bandeja", "bandejas", "kit", "kits"));

    private Unidades() {
    }

    /** Vazio ou "null" conta como unidade inteira: é o padrão de quem não preencheu. */
    public static boolean inteira(String unidade) {
        if (unidade == null) return true;
        String u = unidade.trim().toLowerCase(Locale.ROOT).replace(".", "");
        return u.isEmpty() || "null".equals(u) || INTEIRAS.contains(u);
    }

    public static boolean fracionada(double quantidade) {
        return Math.abs(quantidade - Math.rint(quantidade)) > 1e-9;
    }

    public static String mensagemFracao(String unidade) {
        String u = unidade == null || unidade.trim().isEmpty() || "null".equals(unidade) ? "" : unidade.trim();
        String nome = u.isEmpty() || "un".equalsIgnoreCase(u) ? "unidade" : u;
        return "Este produto é contado por " + nome + ", sem fração: informe um número inteiro.";
    }
}
