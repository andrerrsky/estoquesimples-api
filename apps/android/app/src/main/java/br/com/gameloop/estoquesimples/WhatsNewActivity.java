package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MenuItem;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

import java.util.List;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.changelog.ChangelogLoader;
import br.com.gameloop.estoquesimples.changelog.Release;

/**
 * Novidades do app: o que mudou em cada versão.
 *
 * Existe porque o trabalho feito não chegava a quem usa — a pessoa atualizava
 * e nunca sabia o que tinha ganhado. A lista vem dos assets
 * ({@code packages/changelog}, a mesma fonte da web), então abre offline e
 * mostra exatamente o que <b>esta</b> versão instalada tem.
 *
 * A versão do aparelho ganha um selo próprio: é o ponto de referência de quem
 * está lendo ("daqui para cima é o que eu ainda não tenho").
 */
public class WhatsNewActivity extends BaseActivity {

    public static void open(Context context, String origem) {
        Intent intent = new Intent(context, WhatsNewActivity.class);
        intent.putExtra("origem", origem);
        context.startActivity(intent);
    }

    private LinearLayout container;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_whats_new);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Novidades");
        }
        container = findViewById(R.id.whatsNewContainer);

        String origem = getIntent() != null ? getIntent().getStringExtra("origem") : null;
        Analytics.track(this, "whatsnew.viewed", Analytics.props(
                "origin", origem == null ? "menu" : origem,
                "version", BuildConfig.VERSION_CODE));

        render();
    }

    private void render() {
        List<Release> releases = ChangelogLoader.carregar(this);
        if (releases.isEmpty()) {
            container.addView(texto("As novidades desta versão não puderam ser carregadas.",
                    R.style.TextAppearance_Estoque_Supporting));
            return;
        }

        int instalada = BuildConfig.VERSION_CODE;
        boolean temMaisNova = releases.get(0).version > instalada;

        TextView intro = texto(temMaisNova
                        ? "Você está na versão " + instalada + ". Já existe uma versão mais nova na Play Store."
                        : "Você está na versão " + instalada + ", a mais recente.",
                R.style.TextAppearance_Estoque_Supporting);
        container.addView(intro);

        for (Release release : releases) {
            container.addView(cartao(release, release.version == instalada));
        }

        TextView rodape = texto("As versões chegam pela Play Store, conforme a atualização automática do aparelho.",
                R.style.TextAppearance_Estoque_Caption);
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) rodape.getLayoutParams();
        lp.topMargin = dp(16);
        rodape.setLayoutParams(lp);
        container.addView(rodape);
    }

    private View cartao(Release release, boolean instalada) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_surface);
        int pad = dp(16);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        card.setLayoutParams(params);

        LinearLayout topo = new LinearLayout(this);
        topo.setOrientation(LinearLayout.HORIZONTAL);
        topo.setGravity(Gravity.CENTER_VERTICAL);
        topo.addView(selo("Versão " + release.version, instalada));
        TextView data = texto(release.dataLegivel(), R.style.TextAppearance_Estoque_Caption);
        LinearLayout.LayoutParams dataParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        dataParams.leftMargin = dp(8);
        data.setLayoutParams(dataParams);
        topo.addView(data);
        if (instalada) {
            TextView aqui = texto("você está aqui", R.style.TextAppearance_Estoque_Caption);
            LinearLayout.LayoutParams aquiParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            aquiParams.leftMargin = dp(8);
            aqui.setLayoutParams(aquiParams);
            aqui.setTextColor(ContextCompat.getColor(this, R.color.color_brand));
            aqui.setTypeface(null, Typeface.BOLD);
            topo.addView(aqui);
        }
        card.addView(topo);

        TextView titulo = texto(release.title, R.style.TextAppearance_Estoque_Title);
        LinearLayout.LayoutParams tituloParams = (LinearLayout.LayoutParams) titulo.getLayoutParams();
        tituloParams.topMargin = dp(8);
        titulo.setLayoutParams(tituloParams);
        card.addView(titulo);

        for (String linha : release.highlights) {
            card.addView(item(linha, true));
        }
        for (String linha : release.fixes) {
            card.addView(item(linha, false));
        }
        return card;
    }

    /** "Novidade" e "correção" se distinguem pelo marcador, não pela cor do texto. */
    private View item(String linha, boolean novidade) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        row.setLayoutParams(params);

        TextView marcador = new TextView(this);
        marcador.setText(novidade ? "+" : "•");
        marcador.setTypeface(null, Typeface.BOLD);
        marcador.setTextColor(ContextCompat.getColor(this,
                novidade ? R.color.color_success : R.color.color_text_muted));
        LinearLayout.LayoutParams marcadorParams = new LinearLayout.LayoutParams(dp(16),
                LinearLayout.LayoutParams.WRAP_CONTENT);
        marcador.setLayoutParams(marcadorParams);
        row.addView(marcador);

        TextView corpo = texto(linha, novidade
                ? R.style.TextAppearance_Estoque_Body
                : R.style.TextAppearance_Estoque_Body_Muted);
        LinearLayout.LayoutParams corpoParams = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        corpo.setLayoutParams(corpoParams);
        row.addView(corpo);
        return row;
    }

    private TextView selo(String rotulo, boolean instalada) {
        TextView selo = new TextView(this);
        selo.setText(rotulo);
        selo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        selo.setTypeface(null, Typeface.BOLD);
        selo.setBackgroundResource(instalada
                ? R.drawable.bg_version_chip_current : R.drawable.bg_version_chip);
        selo.setTextColor(ContextCompat.getColor(this,
                instalada ? R.color.color_text_on_brand : R.color.color_text_muted));
        selo.setPadding(dp(10), dp(4), dp(10), dp(4));
        return selo;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private TextView texto(String valor, int style) {
        TextView view = new TextView(this);
        view.setTextAppearance(style);
        view.setText(valor);
        view.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return view;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
