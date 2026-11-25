package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.MenuItem;
import android.widget.LinearLayout;
import android.widget.TextView;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.branding.BrandStore;
import br.com.gameloop.estoquesimples.data.BatchRepository;
import br.com.gameloop.estoquesimples.data.Dias;
import br.com.gameloop.estoquesimples.data.LocalDb;

/**
 * Validades: os lotes em estoque, o que vence primeiro na frente.
 *
 * Nada aqui é editável. Lote não é cadastro, é o que as entradas contaram:
 * para corrigir, estorna-se a entrada e lança-se de novo — a mesma regra do
 * resto do estoque (movimentação é fato, não campo).
 */
public class ExpiryActivity extends BaseActivity {

    private static final String TAG = "ExpiryActivity";

    /** Janela de "vence logo", em dias. */
    private static final int JANELA = 30;

    public static void open(Context context, String origem) {
        Intent intent = new Intent(context, ExpiryActivity.class);
        intent.putExtra("origem", origem);
        context.startActivity(intent);
    }

    private LinearLayout container;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_expiry);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Validades");
        }
        container = findViewById(R.id.expiryContainer);
        String origem = getIntent() != null ? getIntent().getStringExtra("origem") : null;
        Analytics.track(this, "expiry.viewed",
                Analytics.props("origin", origem == null ? "menu" : origem));
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        container.removeAllViews();
        if (!ensureDatabaseAvailable()) {
            container.addView(text("Não foi possível abrir o estoque agora.",
                    R.style.TextAppearance_Estoque_Supporting));
            return;
        }

        BatchRepository.Resumo resumo;
        synchronized (MainActivity.DB_LOCK) {
            resumo = new BatchRepository(MainActivity.stock).listar(null, JANELA);
        }

        if (resumo.lotes.isEmpty()) {
            container.addView(text("Nenhum lote em estoque ainda.\n\nAo registrar uma entrada, "
                            + "informe o lote e a validade da mercadoria: o que vence primeiro "
                            + "aparece aqui na frente.",
                    R.style.TextAppearance_Estoque_Supporting));
            return;
        }

        StringBuilder resumoTexto = new StringBuilder();
        resumoTexto.append(Texto.plural(resumo.lotes.size(), "lote", "lotes")).append(" em estoque");
        if (resumo.vencidos > 0) {
            resumoTexto.append(" · ").append(resumo.vencidos).append(" vencido")
                    .append(resumo.vencidos > 1 ? "s" : "");
        }
        if (resumo.vencendo > 0) {
            resumoTexto.append(" · ").append(resumo.vencendo).append(" vence")
                    .append(resumo.vencendo > 1 ? "m" : "").append(" em ").append(JANELA).append(" dias");
        }
        if (resumo.semLote > 0d) {
            resumoTexto.append("\n").append(CurrencyHelper.formatQuantity(resumo.semLote))
                    .append(" em estoque entraram sem lote informado e não aparecem na lista.");
        }
        container.addView(text(resumoTexto.toString(), R.style.TextAppearance_Estoque_Supporting));

        for (BatchRepository.Lote lote : resumo.lotes) {
            container.addView(card(lote));
        }
    }

    private LinearLayout card(BatchRepository.Lote lote) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_surface);
        int pad = dp(16);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        card.setLayoutParams(params);

        card.addView(text(lote.productName == null ? "(produto sem nome)" : lote.productName,
                R.style.TextAppearance_Estoque_Title));

        TextView prazo = text(prazoLegivel(lote), R.style.TextAppearance_Estoque_Section);
        if (lote.vencido()) {
            // Vencido é o único estado que pede ação hoje; o resto é leitura.
            prazo.setTextColor(BrandStore.color(this, R.color.color_error));
        }
        card.addView(prazo);

        StringBuilder detalhe = new StringBuilder();
        detalhe.append(lote.code == null ? "Sem lote" : "Lote " + lote.code);
        detalhe.append(" · ").append(CurrencyHelper.formatQuantity(lote.quantity));
        if (lote.unit != null && !lote.unit.isEmpty() && !"null".equals(lote.unit)) {
            detalhe.append(" ").append(lote.unit);
        }
        if (lote.manufacturedOn != null) {
            detalhe.append(" · fabricado em ").append(Dias.legivel(lote.manufacturedOn));
        }
        card.addView(text(detalhe.toString(), R.style.TextAppearance_Estoque_Supporting));
        return card;
    }

    private String prazoLegivel(BatchRepository.Lote lote) {
        if (lote.expiresOn == null || lote.daysToExpire == null) {
            return "Sem validade informada";
        }
        String data = Dias.legivel(lote.expiresOn);
        int dias = lote.daysToExpire;
        if (dias < 0) {
            return "Venceu em " + data + (dias == -1 ? " (ontem)" : " (há " + (-dias) + " dias)");
        }
        if (dias == 0) {
            return "Vence hoje, " + data;
        }
        if (dias == 1) {
            return "Vence amanhã, " + data;
        }
        return "Vence em " + data + " (faltam " + dias + " dias)";
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private TextView text(String value, int style) {
        TextView view = new TextView(this);
        view.setTextAppearance(style);
        view.setText(value);
        view.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return view;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private boolean ensureDatabaseAvailable() {
        try {
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }
            if (MainActivity.instance != null) {
                MainActivity.instance.openOrCreateDB();
                return MainActivity.stock != null && MainActivity.stock.isOpen();
            }
            MainActivity.stock = LocalDb.open(this);
            return MainActivity.stock != null && MainActivity.stock.isOpen();
        } catch (Exception e) {
            Log.e(TAG, "banco indisponível", e);
            return false;
        }
    }
}
