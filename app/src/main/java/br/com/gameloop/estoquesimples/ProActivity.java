package br.com.gameloop.estoquesimples;

import android.os.Bundle;

/**
 * A compra única da Versão PRO não é mais oferecida.
 *
 * A activity permanece no manifesto para atalhos e histórico antigos:
 * qualquer abertura cai na tela de assinatura, onde a compra antiga
 * ainda pode ser recuperada no rodapé.
 */
public class ProActivity extends BaseActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SubscriptionActivity.open(this);
        finish();
    }
}
