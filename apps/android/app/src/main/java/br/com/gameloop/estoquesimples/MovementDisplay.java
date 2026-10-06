package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.branding.BrandStore;
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
            // Mudar a quantidade pela tela Editar grava "edicao", mas para
            // quem lê o histórico isso é um ajuste de saldo como outro
            // qualquer — "EDIÇÃO" sugeria alteração de cadastro.
            case MovementRepository.EDICAO:
            case MovementRepository.AJUSTE:
                return "AJUSTE";
            // "ESTORNO" é o termo que o comércio usa e cabe no selo da lista;
            // "CANCELAMENTO" quebrava em duas linhas ("CANCELAME / NTO").
            case MovementRepository.CANCELAMENTO:
                return "ESTORNO";
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
                : BrandStore.color(context, R.color.color_accent);
    }
}
