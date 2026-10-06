package br.com.gameloop.estoquesimples.branding;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.util.AttributeSet;
import android.content.Context;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.ActionBar;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.color.ColorResourcesOverride;

/**
 * Aplica a identidade visual da empresa sobre as telas existentes.
 *
 * Nenhuma tela tem variação por empresa: as cores do tema entram por
 * <b>sobreposição de recursos</b> (os mesmos {@code @color/...} que os layouts
 * e os ícones já usam passam a valer outro valor), então tudo o que usa a cor
 * da marca muda junto, sem tocar na estrutura. A sobreposição existe a partir
 * do Android 11 (API 30); abaixo disso o app aplica o que o código controla
 * (barras, destaques em texto, logotipo) e o resto fica no visual padrão.
 */
public final class BrandApplier {

    private static final String TAG = "BrandApplier";

    private BrandApplier() {
    }

    /** Antes de inflar qualquer layout (início do onCreate). Nunca lança. */
    @SuppressLint("RestrictedApi")
    public static void apply(Activity activity) {
        try {
            Brand brand = BrandStore.current(activity);
            if (brand == null) {
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                ColorResourcesOverride override = ColorResourcesOverride.getInstance();
                if (override != null) {
                    override.applyIfPossible(activity, brand.colorOverrides());
                }
            }
            if (brand.serif && activity instanceof AppCompatActivity) {
                installSerif((AppCompatActivity) activity);
            }
        } catch (RuntimeException e) {
            // Marca é enfeite: qualquer problema deixa o visual padrão.
            Log.w(TAG, "marca não aplicada: " + e);
        }
    }

    /** Depois do conteúdo montado: cor da barra em aparelhos sem sobreposição de recursos. */
    public static void applyChrome(AppCompatActivity activity) {
        try {
            Brand brand = BrandStore.current(activity);
            if (brand == null || Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return;
            }
            ActionBar bar = activity.getSupportActionBar();
            if (bar != null) {
                bar.setBackgroundDrawable(new ColorDrawable(brand.primary));
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "barra não pintada: " + e);
        }
    }

    /**
     * Logotipo da empresa na barra superior, no lugar do ícone. Só na tela
     * inicial, para ficar discreto; sem logotipo em cache, não faz nada.
     */
    public static void applyLogo(AppCompatActivity activity) {
        try {
            Brand brand = BrandStore.current(activity);
            ActionBar bar = activity.getSupportActionBar();
            if (bar == null) {
                return;
            }
            int height = Math.round(activity.getResources().getDisplayMetrics().density * 32);
            android.graphics.drawable.Drawable logo = BrandLogo.barDrawable(activity, brand, height);
            if (logo == null) {
                return;
            }
            bar.setLogo(logo);
            bar.setDisplayUseLogoEnabled(true);
            bar.setDisplayShowHomeEnabled(true);
        } catch (RuntimeException e) {
            Log.w(TAG, "logotipo não aplicado: " + e);
        }
    }

    /** Fonte com serifa: todo TextView criado pela tela (inclusive itens de lista) nasce com ela. */
    private static void installSerif(AppCompatActivity activity) {
        LayoutInflater inflater = activity.getLayoutInflater();
        if (inflater.getFactory2() != null) {
            return;
        }
        inflater.setFactory2(new LayoutInflater.Factory2() {
            @Nullable
            @Override
            public View onCreateView(@Nullable View parent, String name, Context context, AttributeSet attrs) {
                View view = activity.getDelegate().createView(parent, name, context, attrs);
                if (view instanceof TextView) {
                    TextView text = (TextView) view;
                    Typeface current = text.getTypeface();
                    text.setTypeface(Typeface.create(Typeface.SERIF, current == null ? Typeface.NORMAL : current.getStyle()));
                }
                return view;
            }

            @Nullable
            @Override
            public View onCreateView(String name, Context context, AttributeSet attrs) {
                return onCreateView(null, name, context, attrs);
            }
        });
    }
}
