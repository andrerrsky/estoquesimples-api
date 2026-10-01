package br.com.gameloop.estoquesimples;

import android.app.Activity;

import androidx.appcompat.app.AlertDialog;

import br.com.gameloop.estoquesimples.sync.ApiException;

/**
 * Aviso quando a chamada não consegue falar com o servidor.
 *
 * O spinner de quem chamou já foi desligado. "Tentar novamente" repete a ação,
 * que por sua vez volta a fazer as duas tentativas do cliente HTTP.
 */
public final class ConnectivityPrompt {

    private ConnectivityPrompt() {}

    public static boolean isOffline(Throwable error) {
        return error instanceof ApiException
                && ApiException.SEM_REDE.equals(((ApiException) error).getCode());
    }

    /** @return true quando o diálogo cobre o erro e a mensagem de banner não deve aparecer. */
    public static boolean report(Activity activity, Throwable error, Runnable onRetry) {
        if (!isOffline(error)) {
            return false;
        }
        show(activity, onRetry);
        return true;
    }

    public static void show(Activity activity, Runnable onRetry) {
        if (activity == null || activity.isFinishing()) {
            return;
        }
        new AlertDialog.Builder(activity)
                .setTitle("Sem conexão")
                .setMessage("O dispositivo parece estar com problemas de conectividade.")
                .setPositiveButton("Tentar novamente", (dialog, which) -> {
                    if (onRetry != null) {
                        onRetry.run();
                    }
                })
                .setNegativeButton("Fechar", null)
                .show();
    }

    /**
     * Sair da conta pode ser concluído no aparelho mesmo sem o servidor.
     * Fechar deixa a sessão como está.
     */
    public static void showLogout(Activity activity, Runnable onRetry, Runnable onLeaveAnyway) {
        if (activity == null || activity.isFinishing()) {
            return;
        }
        new AlertDialog.Builder(activity)
                .setTitle("Sem conexão")
                .setMessage("O dispositivo parece estar com problemas de conectividade.")
                .setPositiveButton("Tentar novamente", (dialog, which) -> {
                    if (onRetry != null) {
                        onRetry.run();
                    }
                })
                .setNegativeButton("Sair mesmo assim", (dialog, which) -> {
                    if (onLeaveAnyway != null) {
                        onLeaveAnyway.run();
                    }
                })
                .setNeutralButton("Fechar", null)
                .show();
    }
}
