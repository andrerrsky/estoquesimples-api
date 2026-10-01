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
        // A snackbar cobria os botões Entrada/Saída do último card: um toque
        // tardio no "Desfazer" abria o diálogo de outro produto. Enquanto ela
        // está na tela, a lista ganha o mesmo espaço embaixo (clipToPadding
        // já é false) e o conteúdo rola para cima dela.
        final android.widget.ListView list = activity.findViewById(R.id.listView);
        if (list != null) {
            final int paddingOriginal = list.getPaddingBottom();
            snackbar.addCallback(new Snackbar.Callback() {
                @Override
                public void onShown(Snackbar sb) {
                    int altura = sb.getView().getHeight();
                    if (altura <= 0) {
                        altura = Math.round(64 * activity.getResources().getDisplayMetrics().density);
                    }
                    list.setPadding(list.getPaddingLeft(), list.getPaddingTop(),
                            list.getPaddingRight(), paddingOriginal + altura);
                }

                @Override
                public void onDismissed(Snackbar sb, int event) {
                    list.setPadding(list.getPaddingLeft(), list.getPaddingTop(),
                            list.getPaddingRight(), paddingOriginal);
                }
            });
        }
        return snackbar;
    }
}
