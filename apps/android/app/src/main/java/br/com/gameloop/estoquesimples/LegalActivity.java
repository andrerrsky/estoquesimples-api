package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.branding.BrandStore;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.Html;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Termos de Uso e Política de Privacidade, lidos a partir de arquivos locais.
 *
 * A tela não depende de rede: o texto viaja com o aplicativo. Se o WebView do
 * aparelho estiver indisponível, o mesmo HTML aparece em um ScrollView simples.
 */
public final class LegalActivity extends BaseActivity {

    static final String EXTRA_PAGE = "page";

    private static final String TAG = "LegalActivity";
    private static final String ASSET_TERMOS = "legal/termos.html";
    private static final String ASSET_PRIVACIDADE = "legal/privacidade.html";

    private FrameLayout content;
    private ScrollView fallback;
    private TextView fallbackText;
    private View tabTermos;
    private View tabPrivacidade;
    private TextView tabTermosLabel;
    private TextView tabPrivacidadeLabel;
    private View tabTermosIndicator;
    private View tabPrivacidadeIndicator;

    private WebView webView;
    private String page = LegalDocuments.PAGE_TERMOS;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_legal);

        page = resolvePage(savedInstanceState != null
                ? savedInstanceState.getString(EXTRA_PAGE)
                : getIntent().getStringExtra(EXTRA_PAGE));

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }

        content = findViewById(R.id.legalContent);
        fallback = findViewById(R.id.legalFallback);
        fallbackText = findViewById(R.id.legalFallbackText);
        tabTermos = findViewById(R.id.tabTermos);
        tabPrivacidade = findViewById(R.id.tabPrivacidade);
        tabTermosLabel = findViewById(R.id.tabTermosLabel);
        tabPrivacidadeLabel = findViewById(R.id.tabPrivacidadeLabel);
        tabTermosIndicator = findViewById(R.id.tabTermosIndicator);
        tabPrivacidadeIndicator = findViewById(R.id.tabPrivacidadeIndicator);

        tabTermos.setOnClickListener(v -> mostrar(LegalDocuments.PAGE_TERMOS));
        tabPrivacidade.setOnClickListener(v -> mostrar(LegalDocuments.PAGE_PRIVACIDADE));

        prepararConteudo();
        mostrar(page);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(EXTRA_PAGE, page);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            content.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void prepararConteudo() {
        try {
            WebView view = new WebView(this);
            configurarWebView(view);
            content.addView(view, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            webView = view;
            fallback.setVisibility(View.GONE);
        } catch (Throwable t) {
            Log.w(TAG, "WebView indisponível; usando texto simples", t);
            webView = null;
            fallback.setVisibility(View.VISIBLE);
        }
    }

    private void configurarWebView(WebView view) {
        view.getSettings().setJavaScriptEnabled(false);
        view.getSettings().setAllowFileAccess(true);
        view.getSettings().setAllowContentAccess(false);
        view.getSettings().setDomStorageEnabled(false);
        view.getSettings().setBuiltInZoomControls(true);
        view.getSettings().setDisplayZoomControls(false);
        view.getSettings().setSupportZoom(true);
        view.getSettings().setLoadWithOverviewMode(true);
        view.getSettings().setUseWideViewPort(false);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return tratarUrl(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return tratarUrl(Uri.parse(url));
            }
        });
    }

    private boolean tratarUrl(Uri uri) {
        if (uri == null) {
            return true;
        }
        String scheme = uri.getScheme();
        if ("mailto".equalsIgnoreCase(scheme)) {
            try {
                startActivity(new Intent(Intent.ACTION_SENDTO, uri));
            } catch (Exception ignored) {
                // Sem app de e-mail o texto do documento continua visível.
            }
            return true;
        }
        if ("file".equalsIgnoreCase(scheme)) {
            return false;
        }
        return true;
    }

    private void mostrar(String destino) {
        page = resolvePage(destino);
        boolean termos = LegalDocuments.PAGE_TERMOS.equals(page);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle(termos ? "Termos de uso" : "Política de privacidade");
        }

        int brand = BrandStore.color(this, R.color.color_accent);
        int muted = ContextCompat.getColor(this, R.color.color_text_muted);
        tabTermosLabel.setTextColor(termos ? brand : muted);
        tabPrivacidadeLabel.setTextColor(termos ? muted : brand);
        tabTermosIndicator.setBackgroundColor(termos ? brand : android.graphics.Color.TRANSPARENT);
        tabPrivacidadeIndicator.setBackgroundColor(termos ? android.graphics.Color.TRANSPARENT : brand);

        String asset = termos ? ASSET_TERMOS : ASSET_PRIVACIDADE;
        String html = lerAsset(asset);
        if (webView != null) {
            webView.loadDataWithBaseURL(
                    "file:///android_asset/legal/",
                    html,
                    "text/html",
                    "utf-8",
                    null);
            webView.scrollTo(0, 0);
            return;
        }
        CharSequence texto = Html.fromHtml(html, Html.FROM_HTML_MODE_LEGACY);
        fallbackText.setText(texto);
        fallback.setVisibility(View.VISIBLE);
        fallback.scrollTo(0, 0);
    }

    private static String resolvePage(String page) {
        if (LegalDocuments.PAGE_PRIVACIDADE.equals(page)) {
            return LegalDocuments.PAGE_PRIVACIDADE;
        }
        return LegalDocuments.PAGE_TERMOS;
    }

    private String lerAsset(String caminho) {
        try (InputStream in = getAssets().open(caminho);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int lido;
            while ((lido = in.read(buf)) != -1) {
                out.write(buf, 0, lido);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            Log.w(TAG, "falha ao ler " + caminho, e);
            return "Não foi possível abrir este documento neste aparelho.";
        }
    }
}
