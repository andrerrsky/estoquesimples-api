package br.com.gameloop.estoquesimples.photos;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import br.com.gameloop.estoquesimples.ImageLoadHelper;
import br.com.gameloop.estoquesimples.PhotoPathHelper;
import br.com.gameloop.estoquesimples.R;

/**
 * Foto do produto em tela cheia, dentro do próprio app (antes abria o app de
 * galeria do aparelho, e às vezes nenhum aparecia). Fundo preto, zoom por
 * pinça e toque duplo, nome do produto em cima; toque simples, voltar ou o
 * X fecham.
 */
public final class PhotoViewer {

    private PhotoViewer() {
    }

    public static void show(Activity activity, @Nullable String photoPath, @Nullable String title) {
        if (activity == null || activity.isFinishing() || PhotoPathHelper.isEmptyPhotoReference(photoPath)) {
            return;
        }
        Dialog dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        FrameLayout root = new FrameLayout(activity);
        root.setBackgroundColor(Color.BLACK);

        ZoomImageView image = new ZoomImageView(activity);
        image.setContentDescription(title == null ? "Foto do produto" : "Foto de " + title);
        image.setOnSingleTap(dialog::dismiss);
        root.addView(image, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        float density = activity.getResources().getDisplayMetrics().density;
        int pad = Math.round(12 * density);

        FrameLayout bar = new FrameLayout(activity);
        GradientDrawable shade = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[] {0x99000000, 0x00000000});
        bar.setBackground(shade);
        bar.setPadding(pad, pad, pad, Math.round(28 * density));
        root.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));

        if (title != null && !title.trim().isEmpty()) {
            TextView label = new TextView(activity);
            label.setText(title);
            label.setTextColor(Color.WHITE);
            label.setTextSize(17);
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL);
            lp.setMarginEnd(Math.round(56 * density));
            lp.setMarginStart(Math.round(4 * density));
            bar.addView(label, lp);
        }

        ImageButton close = new ImageButton(activity);
        close.setImageResource(R.drawable.ic_close_white);
        close.setContentDescription("Fechar");
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(0x33FFFFFF);
        close.setBackground(circle);
        close.setOnClickListener(v -> dialog.dismiss());
        int size = Math.round(44 * density);
        bar.addView(close, new FrameLayout.LayoutParams(size, size, Gravity.END | Gravity.CENTER_VERTICAL));

        // Barras do sistema por cima da foto: o botão de fechar desce o suficiente para não ficar sob elas.
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            bar.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, Math.round(28 * density));
            return insets;
        });

        dialog.setContentView(root);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.BLACK));
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.BLACK);
            window.setNavigationBarColor(Color.BLACK);
        }
        ImageLoadHelper.loadDetailImage(activity, photoPath, image);
        dialog.show();
    }
}
