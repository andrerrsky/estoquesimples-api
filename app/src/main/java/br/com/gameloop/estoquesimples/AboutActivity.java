package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.net.Uri;
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

        btnContact.setOnClickListener(v -> openEmailApp());
        btnGoPro.setOnClickListener(v -> SubscriptionActivity.open(this));

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
            title.setText("Sincronize na nuvem");
            subtitle.setText("Sua Versão PRO já remove anúncios. A assinatura adiciona sincronização entre aparelhos.");
            cta.setText("Conhecer o plano");
        } else {
            title.setText("Assinatura");
            subtitle.setText("Sincronize na nuvem, desbloqueie recursos e remova anúncios");
            cta.setText("Conhecer o plano");
        }
    }

    private void openEmailApp() {
        Intent emailIntent = new Intent(Intent.ACTION_SENDTO);
        emailIntent.setData(Uri.parse("mailto:rrandsky@gmail.com"));
        emailIntent.putExtra(Intent.EXTRA_SUBJECT, "Contato - Estoque Simples");
        emailIntent.putExtra(Intent.EXTRA_TEXT, "Olá, gostaria de entrar em contato sobre o aplicativo Estoque Simples.");

        try {
            startActivity(Intent.createChooser(emailIntent, "Enviar email usando:"));
        } catch (android.content.ActivityNotFoundException ex) {
            // Caso não tenha aplicativo de email instalado
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
