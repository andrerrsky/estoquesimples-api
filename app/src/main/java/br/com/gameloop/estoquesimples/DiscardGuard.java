package br.com.gameloop.estoquesimples;

import android.text.Editable;
import android.text.TextWatcher;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Impede que um formulário preenchido seja perdido por um toque em Voltar
 * ou em Cancelar sem aviso. Antes, oito campos digitados sumiam em silêncio
 * — e quem estava no balcão não sabia nem se o produto tinha sido salvo.
 *
 * Marca "sujo" ao primeiro caractere alterado depois de {@link #watch}
 * (chamado depois de a tela preencher os campos, para não contar o
 * preenchimento inicial) ou quando a tela avisa que a foto mudou.
 */
final class DiscardGuard {

    private final AppCompatActivity activity;
    private final String title;
    private boolean dirty;

    DiscardGuard(AppCompatActivity activity, String title) {
        this.activity = activity;
        this.title = title;
        activity.getOnBackPressedDispatcher().addCallback(activity, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                confirmLeave();
            }
        });
    }

    void watch(TextView... fields) {
        TextWatcher watcher = new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                dirty = true;
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        };
        for (TextView field : fields) {
            if (field != null) {
                field.addTextChangedListener(watcher);
            }
        }
    }

    void markDirty() {
        dirty = true;
    }

    /** Fecha a tela na hora se nada foi digitado; senão, pergunta antes. */
    void confirmLeave() {
        if (!dirty) {
            activity.finish();
            return;
        }
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage("O que você digitou nesta tela será perdido.")
                .setPositiveButton("Descartar", (d, w) -> activity.finish())
                .setNegativeButton("Continuar editando", null)
                .show();
        android.widget.Button descartar = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
        if (descartar != null) {
            descartar.setTextColor(androidx.core.content.ContextCompat.getColor(activity, R.color.color_error));
        }
    }
}
