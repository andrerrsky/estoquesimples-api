package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.TextView;

import com.google.android.material.textfield.TextInputLayout;

import br.com.gameloop.estoquesimples.data.Product;

/**
 * Campo "Preço de custo" das telas de cadastro e edição (versão 31).
 *
 * O custo é opcional: quem só conta estoque não precisa dele. Quando a pessoa
 * informa custo e valor de venda, a linha de ajuda mostra na hora a margem e o
 * lucro por unidade — é o que transforma o campo em algo útil, e não em mais
 * um dado para preencher.
 */
final class CostField {

    private CostField() {
    }

    /** Liga o campo ao valor de venda para manter a margem atualizada. */
    static void bind(Context context, TextInputLayout costLayout, TextView cost, TextView value) {
        if (costLayout == null || cost == null || value == null) {
            return;
        }
        costLayout.setHint("Preço de custo (" + CurrencyHelper.getCurrencySymbol(context) + ", opcional)");
        TextWatcher watcher = new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                costLayout.setHelperText(marginText(context, value.getText().toString(), cost.getText().toString()));
            }
        };
        cost.addTextChangedListener(watcher);
        value.addTextChangedListener(watcher);
        costLayout.setHelperText(marginText(context, value.getText().toString(), cost.getText().toString()));
    }

    /** Texto do campo ao abrir a edição: vazio quando o custo não foi informado. */
    static String forEdit(String stored) {
        Double custo = Product.costOf(stored);
        return custo == null ? "" : CurrencyHelper.formatNumber(custo);
    }

    /** Valor a gravar: {@code null} (coluna nula) quando o campo ficou vazio. */
    static String forStorage(TextView cost) {
        if (cost == null) {
            return null;
        }
        String digitado = cost.getText().toString().trim();
        return digitado.isEmpty() ? null : CurrencyHelper.sanitizeForStorage(digitado);
    }

    /**
     * "Margem 40% · lucro de R$ 8,00 por unidade", ou uma dica quando falta
     * um dos dois valores. Margem sobre o preço de venda, como o comércio fala.
     */
    static String marginText(Context context, String valueText, String costText) {
        double venda = CurrencyHelper.parseCurrency(valueText == null ? "" : valueText.trim(), -1);
        double custo = CurrencyHelper.parseCurrency(costText == null ? "" : costText.trim(), -1);
        if (costText == null || costText.trim().isEmpty() || custo < 0) {
            return "Com o custo, o app calcula sua margem e o lucro.";
        }
        if (venda <= 0) {
            return "Informe também o valor de venda para ver a margem.";
        }
        double lucro = venda - custo;
        long margem = Math.round(lucro / venda * 100);
        if (lucro < 0) {
            return "Prejuízo de " + CurrencyHelper.formatCurrency(context, -lucro)
                    + " por unidade (custo maior que a venda).";
        }
        return "Margem " + margem + "% · lucro de " + CurrencyHelper.formatCurrency(context, lucro)
                + " por unidade";
    }
}
