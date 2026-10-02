package br.com.gameloop.estoquesimples;

import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.util.TypedValue;
import android.view.View;

import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Compatibilidade com o edge-to-edge obrigatório a partir do targetSdk 36
 * (Android 16). Mantém ActionBar e conteúdo fora das barras do sistema,
 * com a mesma cor sólida usada anteriormente (#1c679d), e reage ao IME
 * para que campos no topo (ex.: SearchView) não sumam ao abrir o teclado.
 */
public final class EdgeToEdgeHelper {

    private EdgeToEdgeHelper() {
    }

    public static void enable(AppCompatActivity activity) {
        // Ícones claros (brancos) sobre fundo escuro/azul das barras.
        EdgeToEdge.enable(
                activity,
                SystemBarStyle.dark(Color.TRANSPARENT),
                SystemBarStyle.dark(Color.TRANSPARENT)
        );
    }

    public static void applyInsets(AppCompatActivity activity) {
        View content = activity.findViewById(android.R.id.content);
        if (content == null) {
            return;
        }

        // Em temas com ActionBar, o pai de android.R.id.content é o
        // ActionBarOverlayLayout (ActionBar + conteúdo). Aplicar padding nele
        // evita sobreposição da status bar na ActionBar e da nav bar no rodapé.
        View root = content.getParent() instanceof View
                ? (View) content.getParent()
                : content;

        // A raiz recebe a cor das barras (#1c679d). Ela só fica visível nas
        // áreas de padding (status bar / nav bar).
        root.setBackgroundColor(ContextCompat.getColor(activity, R.color.system_bar));

        // A área de conteúdo recebe o fundo padrão do tema (opaco). Sem isso,
        // telas cujo layout raiz não define android:background deixariam o azul
        // da raiz vazar por toda a tela (ex.: listagem principal e Imp/Exp).
        applyThemeWindowBackground(activity, content);

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, windowInsets) -> {
            // systemBars + cutout + ime: com adjustResize o teclado reduz a
            // área útil em vez de empurrar o topo (SearchView) para fora da tela.
            Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
                            | WindowInsetsCompat.Type.ime()
            );
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom);

            // Zera os insets já aplicados na raiz para evitar padding duplo.
            WindowInsetsCompat remaining = new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.NONE)
                    .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                    .build();

            // Repassa para a implementação do AppCompat: o ActionBarOverlayLayout
            // depende de receber os insets para deslocar o conteúdo abaixo da
            // ActionBar. Sem isso, a ActionBar cobre o topo da tela (SearchView).
            return ViewCompat.onApplyWindowInsets(v, remaining);
        });
        ViewCompat.requestApplyInsets(root);
    }

    /**
     * Aplica o fundo padrão do tema (android:windowBackground) na área de
     * conteúdo, garantindo opacidade mesmo quando o layout da tela não define
     * um fundo próprio. Cai para branco caso não seja possível resolver.
     */
    private static void applyThemeWindowBackground(AppCompatActivity activity, View content) {
        TypedValue tv = new TypedValue();
        if (activity.getTheme().resolveAttribute(android.R.attr.windowBackground, tv, true)) {
            if (tv.type >= TypedValue.TYPE_FIRST_COLOR_INT
                    && tv.type <= TypedValue.TYPE_LAST_COLOR_INT) {
                content.setBackgroundColor(tv.data);
                return;
            }
            if (tv.resourceId != 0) {
                try {
                    Drawable bg = ContextCompat.getDrawable(activity, tv.resourceId);
                    if (bg != null) {
                        content.setBackground(bg);
                        return;
                    }
                } catch (Exception ignored) {
                    // Recurso não resolvível (ex.: drawable com atributos de tema).
                }
            }
        }
        content.setBackgroundColor(Color.WHITE);
    }
}
