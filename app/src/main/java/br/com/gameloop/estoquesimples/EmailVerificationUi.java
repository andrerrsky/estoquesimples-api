package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.os.Handler;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.EditText;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import java.util.concurrent.Executor;

import br.com.gameloop.estoquesimples.sync.AccountService;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Confirmação do e-mail da conta.
 *
 * Convidar alguém envia mensagem em nome da empresa; o servidor só autoriza
 * depois que o próprio endereço foi confirmado. Esta caixa é o caminho para
 * colar o código do e-mail sem sair da tela em que a pessoa estava.
 */
final class EmailVerificationUi {

    interface OnVerified {
        void run();
    }

    private EmailVerificationUi() {}

    static void prompt(
            Activity activity,
            AccountService accounts,
            Executor executor,
            Handler main,
            OnVerified onVerified) {
        String email = SessionManager.get(activity).userEmail();
        View caixa = LayoutInflater.from(activity).inflate(R.layout.dialog_verify_email, null);
        EditText campo = caixa.findViewById(R.id.verifyEmailCodeField);

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Confirme seu e-mail")
                .setMessage("Enviamos um código para " + (email != null ? email : "sua conta")
                        + ". Cole o código inteiro da mensagem. Sem essa confirmação "
                        + "não é possível convidar outras pessoas, mesmo sendo o "
                        + "proprietário da empresa.")
                .setView(caixa)
                .setNegativeButton("Agora não", null)
                .setNeutralButton("Reenviar", null)
                .setPositiveButton("Confirmar", null)
                .create();

        dialog.setOnShowListener(shown -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String codigo = campo.getText() != null ? campo.getText().toString().trim() : "";
                if (codigo.length() < 20) {
                    campo.setError("Cole o código inteiro que chegou no e-mail.");
                    return;
                }
                confirmar(activity, accounts, executor, main, dialog, codigo, onVerified);
            });
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v ->
                    reenviar(activity, accounts, executor, main));
        });
        dialog.show();
    }

    private static void confirmar(
            Activity activity,
            AccountService accounts,
            Executor executor,
            Handler main,
            AlertDialog dialog,
            String codigo,
            OnVerified onVerified) {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
        executor.execute(() -> {
            try {
                accounts.confirmEmail(codigo);
                main.post(() -> {
                    if (activity.isFinishing()) {
                        return;
                    }
                    dialog.dismiss();
                    Toast.makeText(activity, "E-mail confirmado.", Toast.LENGTH_SHORT).show();
                    if (onVerified != null) {
                        onVerified.run();
                    }
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (activity.isFinishing()) {
                        return;
                    }
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);
                    Toast.makeText(activity, e.userMessage(), Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private static void reenviar(
            Activity activity,
            AccountService accounts,
            Executor executor,
            Handler main) {
        executor.execute(() -> {
            try {
                accounts.resendVerification();
                main.post(() -> {
                    if (!activity.isFinishing()) {
                        Toast.makeText(activity, "Código reenviado. Confira sua caixa de entrada.",
                                Toast.LENGTH_LONG).show();
                    }
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (!activity.isFinishing()) {
                        Toast.makeText(activity, e.userMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            }
        });
    }
}
