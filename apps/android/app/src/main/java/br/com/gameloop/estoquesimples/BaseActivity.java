package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.branding.BrandApplier;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Activity base que aplica edge-to-edge de forma segura em todas as telas.
 */
public abstract class BaseActivity extends AppCompatActivity {

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        // Identidade visual da empresa: antes de qualquer layout ser inflado.
        BrandApplier.apply(this);
        EdgeToEdgeHelper.enable(this);
        super.onCreate(savedInstanceState);
        EstoqueFirebaseMessagingService.ensureChannel(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Uma linha por tela: o nome da Activity é o identificador do evento.
        Analytics.screen(this);
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
