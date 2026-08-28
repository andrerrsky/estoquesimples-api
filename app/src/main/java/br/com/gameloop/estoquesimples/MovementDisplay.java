package br.com.gameloop.estoquesimples;

import android.content.Context;

import androidx.core.content.ContextCompat;

import br.com.gameloop.estoquesimples.data.MovementRepository;

/**
 * Como cada tipo de movimentação aparece na tela.
 *
 * O histórico passou a registrar mais do que entrada e saída: cadastro,
 * importação, edição, ajuste e cancelamento também são eventos. As telas
 * decidiam o rótulo com um {@code isEntrada ? "ENTRADA" : "SAÍDA"}, o que
 * mostraria "SAÍDA" para um cadastro. Concentrar a decisão aqui evita que cada
 * tela invente a sua própria tradução.
 */
final class MovementDisplay {

    private MovementDisplay() {
    }

    static String label(String changeType) {
        if (changeType == null) {
            return "MOVIMENTAÇÃO";
        }
        switch (changeType.toLowerCase()) {
            case MovementRepository.ENTRADA:
            case "compra":
                return "ENTRADA";
            case MovementRepository.SAIDA:
            case "venda":
                return "SAÍDA";
            case MovementRepository.CADASTRO:
                return "CADASTRO";
            case MovementRepository.IMPORTACAO:
                return "IMPORTAÇÃO";
            case MovementRepository.EDICAO:
                return "EDIÇÃO";
            case MovementRepository.AJUSTE:
                return "AJUSTE";
            case MovementRepository.CANCELAMENTO:
                return "CANCELAMENTO";
            default:
                return changeType.toUpperCase();
        }
    }

    /** Rótulo em frase, para títulos de diálogo. */
    static String sentenceLabel(String changeType) {
        String label = label(changeType);
        return label.charAt(0) + label.substring(1).toLowerCase();
    }

    /**
     * O sinal exibido segue o efeito real no saldo, não o nome do tipo: um
     * ajuste que reduz o estoque precisa aparecer como negativo.
     */
    static String sign(String changeType, double quantity) {
        double effect = MovementRepository.signedQuantity(changeType, quantity);
        if (effect > 0) {
            return "+";
        }
        return effect < 0 ? "-" : "=";
    }

    static int color(Context context, String changeType, double quantity) {
        double effect = MovementRepository.signedQuantity(changeType, quantity);
        if (effect > 0) {
            return ContextCompat.getColor(context, R.color.color_success);
        }
        return effect < 0
                ? ContextCompat.getColor(context, R.color.color_error)
                : ContextCompat.getColor(context, R.color.color_brand);
    }
}
