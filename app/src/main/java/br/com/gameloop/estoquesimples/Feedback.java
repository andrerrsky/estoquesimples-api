package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.view.View;
import android.widget.Toast;

import com.google.android.material.snackbar.Snackbar;

/**
 * Confirmação de ação no rodapé, acima da barra de navegação. O Toast do
 * sistema aparecia por cima da barra (escondendo os rótulos) e sumia antes
 * de ser lido; a Snackbar fica no lugar certo e aceita uma ação ("Desfazer").
 */
public final class Feedback {

    private Feedback() {
    }

    public static void show(Activity activity, String message) {
        make(activity, message, Snackbar.LENGTH_LONG).show();
    }

    public static Snackbar make(Activity activity, String message, int duration) {
        if (activity == null) {
            return null;
        }
        View root = activity.findViewById(android.R.id.content);
        if (root == null) {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
            return null;
        }
        Snackbar snackbar = Snackbar.make(root, message, duration);
        View anchor = activity.findViewById(R.id.bottomNavigation);
        if (anchor != null) {
            snackbar.setAnchorView(anchor);
        }
        return snackbar;
    }
}
