package br.com.gameloop.estoquesimples.data;

import java.util.Calendar;
import java.util.Locale;

/**
 * Dias de calendário em {@code YYYY-MM-DD}.
 *
 * Validade é dia, não instante: guardada como hora, o lote venceria um dia
 * antes ou depois conforme o fuso e o horário de verão de quem olha.
 */
public final class Dias {

    private Dias() {
    }

    /** Hoje no fuso do aparelho, que é o calendário que a pessoa enxerga. */
    public static String hoje() {
        Calendar cal = Calendar.getInstance();
        return String.format(Locale.US, "%04d-%02d-%02d",
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH));
    }

    /** dd/MM/yyyy para a tela; vazio quando não há data. */
    public static String legivel(String dia) {
        if (dia == null || dia.length() < 10) {
            return "";
        }
        return dia.substring(8, 10) + "/" + dia.substring(5, 7) + "/" + dia.substring(0, 4);
    }

    /**
     * Quantos dias faltam de {@code de} até {@code ate} (negativo se passou).
     * Nulo quando qualquer um dos dois não é um dia válido.
     */
    public static Integer entre(String de, String ate) {
        Long inicio = meioDia(de);
        Long fim = meioDia(ate);
        if (inicio == null || fim == null) {
            return null;
        }
        // Meio-dia nos dois lados: a diferença não escorrega com o horário de
        // verão, que move a meia-noite em uma hora.
        return (int) Math.round((fim - inicio) / 86_400_000d);
    }

    private static Long meioDia(String dia) {
        if (dia == null || dia.length() < 10) {
            return null;
        }
        try {
            int ano = Integer.parseInt(dia.substring(0, 4));
            int mes = Integer.parseInt(dia.substring(5, 7));
            int d = Integer.parseInt(dia.substring(8, 10));
            Calendar cal = Calendar.getInstance();
            cal.clear();
            cal.set(ano, mes - 1, d, 12, 0, 0);
            return cal.getTimeInMillis();
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
