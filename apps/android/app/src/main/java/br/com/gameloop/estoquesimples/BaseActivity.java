package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.branding.BrandApplier;
import br.com.gameloop.estoquesimples.branding.BrandStore;

import android.content.Context;
import android.os.Bundle;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.view.ViewGroup;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Activity base que aplica edge-to-edge de forma segura em todas as telas.
 */
public abstract class BaseActivity extends AppCompatActivity {

    /** A marca com que esta tela foi desenhada (cores e logotipo entram no onCreate). */
    private String brandKey = "";

    /** Marca trocada enquanto a tela está visível: refaz a tela com as cores novas. */
    private final BrandStore.Listener brandListener = () -> runOnUiThread(this::recreateIfBrandChanged);

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        // Identidade visual da empresa: antes de qualquer layout ser inflado.
        BrandApplier.apply(this);
        brandKey = BrandStore.key(BrandStore.current(this));
        EdgeToEdgeHelper.enable(this);
        super.onCreate(savedInstanceState);
        EstoqueFirebaseMessagingService.ensureChannel(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Uma linha por tela: o nome da Activity é o identificador do evento.
        Analytics.screen(this);
        BrandStore.addListener(brandListener);
        // A marca pode ter mudado com esta tela em segundo plano (atrás de outra,
        // ou com o app minimizado): ao voltar, ela já aparece com o visual novo.
        recreateIfBrandChanged();
    }

    @Override
    protected void onPause() {
        BrandStore.removeListener(brandListener);
        super.onPause();
    }

    /**
     * Fecha o teclado junto com a tela. Sem isso, sair do cadastro (voltar,
     * seta da barra ou salvar) deixava o teclado aberto por cima da lista: ele
     * pertence à janela que está saindo e o sistema não o recolhe sozinho.
     */
    @Override
    public void finish() {
        hideKeyboard();
        super.finish();
    }

    protected void hideKeyboard() {
        View focus = getCurrentFocus();
        View target = focus != null ? focus : getWindow().getDecorView();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null && target != null) {
            imm.hideSoftInputFromWindow(target.getWindowToken(), 0);
        }
        if (focus != null) {
            focus.clearFocus();
        }
    }

    private void recreateIfBrandChanged() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        String now = BrandStore.key(BrandStore.current(this));
        if (!now.equals(brandKey)) {
            brandKey = now;
            recreate();
        }
    }

    @Override
    public void setContentView(int layoutResID) {
        super.setContentView(layoutResID);
        EdgeToEdgeHelper.applyInsets(this);
        BrandApplier.applyChrome(this);
    }

    @Override
    public void setContentView(View view) {
        super.setContentView(view);
        EdgeToEdgeHelper.applyInsets(this);
    }

    @Override
    public void setContentView(View view, ViewGroup.LayoutParams params) {
        super.setContentView(view, params);
        EdgeToEdgeHelper.applyInsets(this);
    }
}
