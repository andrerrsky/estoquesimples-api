package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.os.Bundle;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

public class AboutActivity extends BaseActivity {

    private PremiumManager premiumManager;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_about);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Sobre");
        }

        premiumManager = PremiumManager.getInstance(this);

        Button btnContact = findViewById(R.id.btnContact);
        Button btnGoPro = findViewById(R.id.btnGoPro);
        View cardLegal = findViewById(R.id.cardLegal);

        btnContact.setOnClickListener(v -> startActivity(new Intent(this, SupportActivity.class)));
        btnGoPro.setOnClickListener(v -> SubscriptionActivity.open(this, "about"));

        if (cardLegal != null) {
            cardLegal.setOnClickListener(v -> LegalDocuments.open(this, LegalDocuments.PAGE_TERMOS));
        }

        updateSubscriptionCard();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateSubscriptionCard();
    }

    private void updateSubscriptionCard() {
        View cardGoPro = findViewById(R.id.cardGoPro);
        TextView title = findViewById(R.id.subscriptionCardTitle);
        TextView subtitle = findViewById(R.id.subscriptionCardSubtitle);
        Button cta = findViewById(R.id.btnGoPro);

        if (premiumManager.hasCloudSubscription()) {
            cardGoPro.setVisibility(View.GONE);
            return;
        }

        cardGoPro.setVisibility(View.VISIBLE);
        if (premiumManager.isPro()) {
            title.setText("Plano Equipe");
            subtitle.setText("Você já tem os recursos premium e a nuvem é grátis com conta. O plano Equipe abre a empresa para sua equipe, sem limite de produtos.");
            cta.setText("Conhecer o plano");
        } else {
            title.setText("Plano Equipe");
            subtitle.setText("Sua equipe no mesmo estoque, produtos sem limite na nuvem e Análise Avançada de Estoque.");
            cta.setText("Conhecer o plano");
        }
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
