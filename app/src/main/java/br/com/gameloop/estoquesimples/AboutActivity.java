package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.net.Uri;
import androidx.cardview.widget.CardView;
import android.os.Bundle;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;

public class AboutActivity extends BaseActivity {

    private PremiumManager premiumManager;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_about);

        // Habilitar botão de voltar na action bar
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Sobre");
        }

        premiumManager = PremiumManager.getInstance(this);

        Button btnContact = findViewById(R.id.btnContact);
        Button btnGoPro = findViewById(R.id.btnGoPro);
        CardView cardGoPro = findViewById(R.id.cardGoPro);

        btnContact.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openEmailApp();
            }
        });

        // Configurar botão Go Pro
        btnGoPro.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showProActivity();
            }
        });

        // Esconder card Go Pro se o usuário já for premium
        if (premiumManager.isPro()) {
            cardGoPro.setVisibility(View.GONE);
        }
    }
    
    @Override
    protected void onResume() {
        super.onResume();
        // Atualizar visibilidade do card Go Pro
        CardView cardGoPro = findViewById(R.id.cardGoPro);
        if (premiumManager.isPro()) {
            cardGoPro.setVisibility(View.GONE);
        } else {
            cardGoPro.setVisibility(View.VISIBLE);
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
    
    private void showProActivity() {
        Intent intent = new Intent(this, ProActivity.class);
        startActivity(intent);
    }
}

