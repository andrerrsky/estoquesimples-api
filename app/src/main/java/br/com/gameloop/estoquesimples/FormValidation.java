package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;
import android.widget.ScrollView;

import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

/**
 * Padrão único de validação: borda e legenda vermelhas no campo (via
 * {@link TextInputLayout#setError}), erro sumindo assim que o campo fica
 * válido, e rolagem até o primeiro campo com problema quando o envio falha.
 *
 * Cada tela monta sua própria lista de checagens chamando {@link #required}
 * ou {@link #check} na ordem em que os campos aparecem, e no fim chama
 * {@link #focusFirstError} — que não faz nada se ninguém estiver com erro.
 */
public final class FormValidation {

    private FormValidation() {
    }

    /**
     * Monta um campo com a mesma borda dos formulários (o tema já aplica
     * {@code Widget.Estoque.TextInputLayout} por padrão) e anexa ao
     * container. Usado nos diálogos que hoje montam um {@code EditText} cru
     * na mão — convidar por e-mail, criar empresa, código de convite,
     * entrada/saída de estoque.
     */
    public static TextInputLayout addField(ViewGroup container, String hint, int inputType) {
        TextInputLayout layout = new TextInputLayout(container.getContext());
        layout.setHint(hint);
        layout.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextInputEditText field = new TextInputEditText(layout.getContext());
        field.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        if (inputType != 0) {
            field.setInputType(inputType);
        }

        layout.addView(field);
        container.addView(layout);
        return layout;
    }

    /** Erro se o campo estiver vazio (ou só espaços). */
    public static boolean required(TextInputLayout layout, String message) {
        boolean blank = layout.getEditText() == null
                || layout.getEditText().getText() == null
                || layout.getEditText().getText().toString().trim().isEmpty();
        return check(layout, blank, message);
    }

    /**
     * Checagem genérica: marca o erro quando {@code hasError} é verdadeiro,
     * limpa quando for falso. Devolve se o campo está válido, para dar para
     * encadear em um {@code &&} ou simplesmente ler o retorno.
     */
    public static boolean check(TextInputLayout layout, boolean hasError, String message) {
        if (hasError) {
            layout.setError(message);
            clearErrorOnEdit(layout);
            return false;
        }
        layout.setError(null);
        return true;
    }

    /**
     * Some com o erro assim que o usuário volta a digitar no campo. Sem isso o
     * campo continuava vermelho, com "Informe a quantidade." embaixo, mesmo já
     * mostrando "10" — o que faz o usuário achar que o valor ainda está
     * errado. O watcher é anexado uma única vez por campo (marcado na tag).
     */
    private static void clearErrorOnEdit(final TextInputLayout layout) {
        if (layout.getEditText() == null || layout.getTag(R.id.tag_clear_error_watcher) != null) {
            return;
        }
        TextWatcher watcher = new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                if (layout.getError() != null) {
                    layout.setError(null);
                }
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        };
        layout.getEditText().addTextChangedListener(watcher);
        layout.setTag(R.id.tag_clear_error_watcher, watcher);
    }

    /**
     * Rola suavemente até o primeiro campo da lista que estiver com erro
     * ativo. Sem efeito se nenhum estiver com erro.
     *
     * A posição é calculada em coordenadas de janela (não soma
     * {@code getTop()} manualmente subindo a árvore) porque os campos ficam
     * aninhados em cartões dentro do ScrollView, e a profundidade varia de
     * tela para tela.
     *
     * Não foca o campo: focar reabriria o teclado, que encolhe a área
     * visível do ScrollView e desalinha a rolagem calculada aqui (o alvo
     * fica na posição de antes do teclado aparecer). A borda e a mensagem
     * vermelhas já deixam claro qual campo precisa de atenção.
     */
    public static void focusFirstError(ScrollView scrollView, TextInputLayout... layoutsInOrder) {
        if (scrollView == null) return;

        TextInputLayout firstError = null;
        for (TextInputLayout layout : layoutsInOrder) {
            if (layout != null && layout.getError() != null) {
                firstError = layout;
                break;
            }
        }
        if (firstError == null) return;

        hideKeyboard(scrollView);

        final TextInputLayout target = firstError;
        scrollView.post(() -> {
            int[] fieldLocation = new int[2];
            int[] scrollLocation = new int[2];
            target.getLocationInWindow(fieldLocation);
            scrollView.getLocationInWindow(scrollLocation);

            int offsetDp = 16;
            float density = scrollView.getResources().getDisplayMetrics().density;
            // O ScrollView das telas de formulário começa atrás da ActionBar
            // e recebe a altura dela como paddingTop (fitsSystemWindows).
            // Sem descontar esse padding, o campo era rolado para debaixo da
            // barra: só a mensagem vermelha ficava visível.
            int targetY = scrollView.getScrollY()
                    + (fieldLocation[1] - scrollLocation[1])
                    - scrollView.getPaddingTop()
                    - Math.round(offsetDp * density);

            scrollView.smoothScrollTo(0, Math.max(0, targetY));
        });
    }

    private static void hideKeyboard(View anyView) {
        View focused = anyView.getRootView().findFocus();
        if (focused == null) {
            focused = anyView;
        }
        InputMethodManager imm = (InputMethodManager)
                anyView.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
    }
}
