package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.data.ConferenceRepository;
import br.com.gameloop.estoquesimples.data.LocalDb;

/**
 * Conferência de estoque (ver docs/conferencia-de-estoque.md).
 *
 * Três etapas numa tela só: escolher o escopo, contar e fechar. A sessão é
 * gravada a cada item, então sair da tela — ou o app morrer — não perde
 * contagem nenhuma.
 *
 * A etapa de contagem é desenhada para o gesto real de quem conta: a pessoa
 * está de pé, com uma mão na mercadoria, tocando **+** a cada unidade. Por
 * isso os botões são redondos e grandes, o caso "bate com o sistema" tem
 * atalho de um toque, e o quanto já falta em dinheiro aparece no topo durante
 * a contagem, não só no fechamento.
 *
 * O limite do plano gratuito é verificado **antes** de contar qualquer coisa.
 * Avisar no fechamento, depois de a pessoa ter contado a loja inteira, é a
 * reclamação número um contra os concorrentes diretos.
 */
public class ConferenceActivity extends BaseActivity {

    private static final String[] REASONS = {"quebra", "furto", "erro de lançamento", "achado"};

    /**
     * Teto de cartões na tela. Cada um tem campo de texto e botões; um escopo
     * "Tudo" com milhares de produtos travaria. Acima disso a tela orienta a
     * conferir por categoria, local ou fornecedor — que é como se conta na
     * prática, prateleira por prateleira.
     */
    static final int MAX_ROWS = 400;

    private static final int FILTRO_TUDO = 0;
    private static final int FILTRO_FALTA = 1;
    private static final int FILTRO_DIVERGENTE = 2;

    public static void open(Context context, String origin) {
        Intent intent = new Intent(context, ConferenceActivity.class);
        intent.putExtra("origem", origin);
        context.startActivity(intent);
    }

    private ConferenceRepository repository;
    private ConferenceRepository.Session session;

    private LinearLayout container;
    private View header;
    private TextView progress;
    private TextView partial;
    private ProgressBar bar;
    private EditText search;
    private LinearLayout filters;
    private View actions;
    private Button scanButton;
    private Button primaryButton;

    /** Motivo escolhido por produto no fechamento. */
    private final Map<String, String> reasons = new HashMap<>();

    private ActivityResultLauncher<ScanOptions> scanLauncher;
    private ActivityResultLauncher<String> cameraPermission;

    private boolean showingSummary;
    private String origin;
    private long startedAtMillis;
    private int filtro = FILTRO_TUDO;
    private String termoBusca = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_conference);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Conferência de estoque");
        }

        container = findViewById(R.id.conferenceContainer);
        header = findViewById(R.id.conferenceHeader);
        progress = findViewById(R.id.conferenceProgress);
        partial = findViewById(R.id.conferencePartial);
        bar = findViewById(R.id.conferenceBar);
        search = findViewById(R.id.conferenceSearch);
        filters = findViewById(R.id.conferenceFilters);
        actions = findViewById(R.id.conferenceActions);
        scanButton = findViewById(R.id.conferenceScanButton);
        primaryButton = findViewById(R.id.conferencePrimaryButton);
        origin = getIntent() != null ? getIntent().getStringExtra("origem") : null;

        repository = new ConferenceRepository(LocalDb.open(this));

        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                termoBusca = s.toString().trim();
                if (!showingSummary && session != null) {
                    renderCounting();
                }
            }
        });

        scanLauncher = registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() != null) {
                onBarcode(result.getContents());
            }
        });
        cameraPermission = registerForActivityResult(
                new androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
                granted -> {
                    if (granted) {
                        launchScanner();
                    } else {
                        toast("Sem acesso à câmera, dá para buscar pelo nome.");
                    }
                });

        session = repository.openSession();
        if (session != null) {
            renderCounting();
        } else {
            renderScopeChooser();
        }
    }

    @Override
    public boolean onSupportNavigateUp() {
        finish();
        return true;
    }

    // ------------------------------------------------------ etapa 1: escopo

    private void renderScopeChooser() {
        showingSummary = false;
        container.removeAllViews();
        header.setVisibility(View.GONE);
        actions.setVisibility(View.GONE);

        boolean paid = PremiumManager.getInstance(this).hasPremiumAccess();
        int remaining = repository.freeRemainingThisMonth();

        if (!paid && remaining <= 0) {
            renderBlocked();
            return;
        }

        addText("Conte o que você tem de verdade e descubra, em reais, o que está faltando.",
                15f, false, R.color.color_text_muted);
        addSpace(16);

        if (!paid && remaining == 1) {
            // O aviso vem agora, antes de contar — nunca no fechamento.
            View aviso = addCard();
            LinearLayout card = (LinearLayout) aviso;
            TextView t = new TextView(this);
            t.setText("Esta é a sua última conferência gratuita do mês. No plano gratuito são "
                    + ConferenceRepository.FREE_MONTHLY_LIMIT + " por mês.");
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
            t.setTextColor(ContextCompat.getColor(this, R.color.color_text));
            card.addView(t);
            addSpace(16);
        }

        addText("O que você vai conferir?", 16f, true, R.color.color_text);
        addSpace(8);

        addScopeButton("Tudo", ConferenceRepository.SCOPE_ALL, null, true);
        addScopeGroup("Por categoria", ConferenceRepository.SCOPE_CATEGORY);
        addScopeGroup("Por local", ConferenceRepository.SCOPE_LOCATION);
        addScopeGroup("Por fornecedor", ConferenceRepository.SCOPE_SUPPLIER);

        addSpace(24);
        addText("Contar por prateleira é mais rápido do que a loja inteira de uma vez, "
                + "e dá para fazer em pedaços ao longo da semana.", 13f, false,
                R.color.color_text_muted);
    }

    private void addScopeGroup(String label, String scopeType) {
        List<String> values = repository.scopeValues(scopeType);
        if (values.isEmpty()) {
            return;
        }
        addSpace(16);
        addText(label, 14f, true, R.color.color_text_muted);
        addSpace(4);
        for (String value : values) {
            addScopeButton(value, scopeType, value, false);
        }
    }

    private void addScopeButton(String label, String scopeType, String scopeValue, boolean primary) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setBackgroundResource(primary
                ? R.drawable.bg_button_primary : R.drawable.bg_button_secondary);
        button.setTextColor(ContextCompat.getColor(this,
                primary ? R.color.color_text_on_brand : R.color.color_brand));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        button.setLayoutParams(params);
        button.setOnClickListener(v -> startSession(scopeType, scopeValue));
        container.addView(button);
    }

    private void renderBlocked() {
        addText("Você já fez as " + ConferenceRepository.FREE_MONTHLY_LIMIT
                + " conferências gratuitas deste mês.", 17f, true, R.color.color_text);
        addSpace(12);
        addText("No plano Equipe a conferência é ilimitada, com histórico para acompanhar "
                + "se a perda está subindo ou caindo.", 15f, false, R.color.color_text_muted);
        addSpace(20);

        Button subscribe = new Button(this);
        subscribe.setText("Conhecer o plano Equipe");
        subscribe.setAllCaps(false);
        subscribe.setBackgroundResource(R.drawable.bg_button_primary);
        subscribe.setTextColor(ContextCompat.getColor(this, R.color.color_text_on_brand));
        subscribe.setOnClickListener(v -> SubscriptionActivity.open(this, "conference"));
        container.addView(subscribe);

        Analytics.track(this, "conference.blocked", Analytics.props(
                "origin", origin == null ? "menu" : origin,
                "done_this_month", repository.finishedThisMonth()));
    }

    private void startSession(String scopeType, String scopeValue) {
        session = repository.start(scopeType, scopeValue);
        if (session == null) {
            toast("Não foi possível iniciar a conferência.");
            return;
        }
        startedAtMillis = System.currentTimeMillis();
        reasons.clear();
        filtro = FILTRO_TUDO;
        termoBusca = "";
        search.setText("");
        Analytics.track(this, "conference.started", Analytics.props(
                "origin", origin == null ? "menu" : origin,
                "scope_type", scopeType,
                "items_in_scope", repository.itemsInScope(session).size()));
        renderCounting();
    }

    // ---------------------------------------------------- etapa 2: contagem

    private void renderCounting() {
        showingSummary = false;
        container.removeAllViews();
        header.setVisibility(View.VISIBLE);
        search.setVisibility(View.VISIBLE);
        filters.setVisibility(View.VISIBLE);
        actions.setVisibility(View.VISIBLE);
        scanButton.setVisibility(View.VISIBLE);
        primaryButton.setText("Fechar conferência");
        primaryButton.setOnClickListener(v -> renderSummary());
        scanButton.setOnClickListener(v -> onScanRequested());

        List<ConferenceRepository.Item> todos = repository.itemsInScope(session);
        List<ConferenceRepository.Item> visiveis = filtrar(todos);

        int mostrados = Math.min(visiveis.size(), MAX_ROWS);
        for (int i = 0; i < mostrados; i++) {
            container.addView(buildCountCard(visiveis.get(i)));
        }

        if (todos.isEmpty()) {
            addText("Nenhum produto neste escopo.", 15f, false, R.color.color_text_muted);
        } else if (visiveis.isEmpty()) {
            addText(filtro == FILTRO_FALTA
                            ? "Tudo conferido neste escopo."
                            : "Nenhum produto com diferença até agora.",
                    15f, true, R.color.color_text);
        } else if (visiveis.size() > MAX_ROWS) {
            addSpace(16);
            addText("Mostrando os primeiros " + MAX_ROWS + " de " + visiveis.size()
                    + " produtos. Para contar o resto, faça a conferência por categoria, "
                    + "local ou fornecedor — é mais rápido e não se perde o lugar.",
                    13f, false, R.color.color_text_muted);
        }

        addSpace(24);
        Button descartar = new Button(this);
        descartar.setText("Descartar esta conferência");
        descartar.setAllCaps(false);
        descartar.setBackgroundResource(R.drawable.bg_button_danger_outline);
        descartar.setTextColor(ContextCompat.getColor(this, R.color.color_error));
        descartar.setOnClickListener(v -> confirmDiscard());
        container.addView(descartar);

        updateProgress(todos);
    }

    private List<ConferenceRepository.Item> filtrar(List<ConferenceRepository.Item> todos) {
        List<ConferenceRepository.Item> out = new ArrayList<>();
        String busca = termoBusca.toLowerCase(Locale.getDefault());
        for (ConferenceRepository.Item item : todos) {
            if (filtro == FILTRO_FALTA && item.isCounted()) {
                continue;
            }
            if (filtro == FILTRO_DIVERGENTE && !item.isDivergent()) {
                continue;
            }
            if (!busca.isEmpty()) {
                String nome = item.name == null ? "" : item.name.toLowerCase(Locale.getDefault());
                if (!nome.contains(busca)) {
                    continue;
                }
            }
            out.add(item);
        }
        return out;
    }

    private void renderFilters(List<ConferenceRepository.Item> todos) {
        filters.removeAllViews();
        int falta = 0;
        int divergentes = 0;
        for (ConferenceRepository.Item item : todos) {
            if (!item.isCounted()) {
                falta++;
            } else if (item.isDivergent()) {
                divergentes++;
            }
        }
        addFilterChip("Todos (" + todos.size() + ")", FILTRO_TUDO);
        addFilterChip("Falta contar (" + falta + ")", FILTRO_FALTA);
        addFilterChip("Com diferença (" + divergentes + ")", FILTRO_DIVERGENTE);
    }

    private void addFilterChip(String label, int valor) {
        TextView chip = new TextView(this);
        chip.setText(label);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        chip.setBackgroundResource(R.drawable.bg_chip_toggle);
        chip.setSelected(filtro == valor);
        chip.setTextColor(ContextCompat.getColor(this,
                filtro == valor ? R.color.color_text_on_brand : R.color.color_text));
        chip.setPadding(dp(14), dp(7), dp(14), dp(7));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.rightMargin = dp(8);
        chip.setLayoutParams(params);
        chip.setOnClickListener(v -> {
            filtro = valor;
            renderCounting();
        });
        filters.addView(chip);
    }

    /**
     * Andamento e prévia do resultado. Recalcula a partir da lista que já foi
     * lida, para não voltar ao banco a cada toque num botão de contagem.
     */
    private void updateProgress(List<ConferenceRepository.Item> todos) {
        // Os contadores dos chips também envelhecem a cada item contado. São
        // três views no cabeçalho, fora da lista: recriá-las não mexe no
        // scroll nem no campo em que a pessoa está digitando.
        renderFilters(todos);

        ConferenceRepository.Summary parcial = ConferenceRepository.Summary.of(todos);
        progress.setText(parcial.counted + " de " + parcial.inScope + " conferidos");
        bar.setMax(Math.max(1, parcial.inScope));
        bar.setProgress(parcial.counted);

        if (parcial.missingValue > 0d && parcial.extraValue > 0d) {
            // Mostrar só a falta esconderia metade do quadro. Em cabeçalho
            // estreito, os dois sinais dizem mais que duas frases.
            partial.setText("−" + CurrencyHelper.formatCurrency(this, parcial.missingValue)
                    + "  +" + CurrencyHelper.formatCurrency(this, parcial.extraValue));
            partial.setTextColor(ContextCompat.getColor(this, R.color.color_text));
        } else if (parcial.missingValue > 0d) {
            partial.setText("faltam " + CurrencyHelper.formatCurrency(this, parcial.missingValue));
            partial.setTextColor(ContextCompat.getColor(this, R.color.color_error));
        } else if (parcial.extraValue > 0d) {
            partial.setText("sobram " + CurrencyHelper.formatCurrency(this, parcial.extraValue));
            partial.setTextColor(ContextCompat.getColor(this, R.color.color_success));
        } else {
            partial.setText("");
        }
    }

    /**
     * Cartão de um produto na contagem.
     *
     * O gesto principal é o **+**: a pessoa toca uma vez por unidade. Por isso
     * o primeiro toque em algo ainda não conferido leva a **1**, e não a
     * "esperado + 1" — quem conta parte do zero, e começar do saldo do sistema
     * transformaria a contagem numa confirmação cega do que já está lá.
     *
     * "Confere" é o atalho do caso mais comum: na vida real a maior parte dos
     * itens bate. Um toque em vez de digitar o número.
     */
    private View buildCountCard(ConferenceRepository.Item item) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_surface);
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.bottomMargin = dp(10);
        card.setLayoutParams(cardParams);

        final String unit = item.unit == null || item.unit.trim().isEmpty() ? "" : " " + item.unit;

        TextView name = new TextView(this);
        name.setText(item.name == null ? "(sem nome)" : item.name);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        name.setTypeface(name.getTypeface(), Typeface.BOLD);
        name.setTextColor(ContextCompat.getColor(this, R.color.color_text));
        card.addView(name);

        TextView expected = new TextView(this);
        expected.setText("no sistema " + CurrencyHelper.formatQuantity(item.expected) + unit);
        expected.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        expected.setTextColor(ContextCompat.getColor(this, R.color.color_text_muted));
        card.addView(expected);

        // Linha de divergência: aparece só quando há diferença, e some quando
        // a contagem passa a bater.
        final TextView diff = new TextView(this);
        diff.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        diff.setTypeface(diff.getTypeface(), Typeface.BOLD);
        diff.setPadding(0, dp(2), 0, 0);
        card.addView(diff);

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(Gravity.CENTER_VERTICAL);
        controls.setPadding(0, dp(10), 0, 0);

        final EditText field = new EditText(this);
        final Button menos = counterButton("–");
        final Button mais = counterButton("+");
        final Button confere = new Button(this);

        controls.addView(menos);

        field.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        field.setGravity(Gravity.CENTER);
        field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f);
        field.setHint("—");
        LinearLayout.LayoutParams fieldParams =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        fieldParams.leftMargin = dp(8);
        fieldParams.rightMargin = dp(8);
        field.setLayoutParams(fieldParams);
        if (item.isCounted()) {
            field.setText(CurrencyHelper.formatQuantity(item.counted));
        }
        controls.addView(field);
        controls.addView(mais);

        card.addView(controls);

        confere.setText("confere: " + CurrencyHelper.formatQuantity(item.expected) + unit);
        confere.setAllCaps(false);
        confere.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        confere.setBackgroundResource(R.drawable.bg_button_subtle);
        confere.setTextColor(ContextCompat.getColor(this, R.color.color_brand));
        LinearLayout.LayoutParams confereParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        confereParams.topMargin = dp(8);
        confere.setLayoutParams(confereParams);
        card.addView(confere);

        final Runnable pintar = () -> {
            Double atual = lerCampo(field);
            if (atual == null) {
                diff.setVisibility(View.GONE);
                return;
            }
            double delta = atual - item.expected;
            if (delta == 0d) {
                diff.setVisibility(View.VISIBLE);
                diff.setText("confere com o sistema");
                diff.setTextColor(ContextCompat.getColor(this, R.color.color_success));
                return;
            }
            diff.setVisibility(View.VISIBLE);
            double valor = delta * item.cost;
            diff.setText((delta < 0 ? "faltam " : "sobram ")
                    + CurrencyHelper.formatQuantity(Math.abs(delta)) + unit
                    + "  ·  " + CurrencyHelper.formatCurrency(this, Math.abs(valor)));
            diff.setTextColor(ContextCompat.getColor(this,
                    delta < 0 ? R.color.color_error : R.color.color_success));
        };
        pintar.run();

        final Runnable salvar = () -> {
            Double valor = lerCampo(field);
            if (valor == null) {
                repository.clearCount(session.uuid, item.productUuid);
            } else {
                repository.count(session.uuid, item.productUuid, valor);
            }
            pintar.run();
            // Só o cabeçalho é recalculado: reconstruir a lista a cada item
            // faria a tela piscar e perder o lugar no meio da contagem.
            updateProgress(repository.itemsInScope(session));
        };

        // Os botões escrevem no campo, o que acorda o TextWatcher. Sem esta
        // trava, cada toque em "+" gravaria duas vezes.
        final boolean[] escrevendoPeloBotao = {false};
        final java.util.function.DoubleConsumer definir = novo -> {
            escrevendoPeloBotao[0] = true;
            field.setText(CurrencyHelper.formatQuantity(novo));
            field.setSelection(field.getText().length());
            escrevendoPeloBotao[0] = false;
            salvar.run();
        };

        menos.setOnClickListener(v -> {
            Double atual = lerCampo(field);
            definir.accept(Math.max(0d, (atual == null ? 0d : atual) - 1d));
        });

        // Começa do zero, não do saldo do sistema: contar é contar, e partir
        // do que já está lá viraria confirmação cega.
        mais.setOnClickListener(v ->
                definir.accept((lerCampo(field) == null ? 0d : lerCampo(field)) + 1d));

        confere.setOnClickListener(v -> definir.accept(item.expected));

        field.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                // Digitar também grava, sem precisar de botão "Ok": o que a
                // pessoa vê na tela é o que está salvo.
                if (!escrevendoPeloBotao[0]) {
                    salvar.run();
                }
            }
        });

        return card;
    }

    private Button counterButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f);
        button.setBackgroundResource(R.drawable.bg_counter_button);
        button.setTextColor(ContextCompat.getColor(this, R.color.color_brand));
        button.setPadding(0, 0, 0, 0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(52), dp(52)));
        return button;
    }

    private Double lerCampo(EditText field) {
        String texto = field.getText().toString().trim();
        if (texto.isEmpty()) {
            return null;
        }
        double valor = CurrencyHelper.parseCurrency(texto, -1d);
        return valor < 0d ? null : valor;
    }

    private void confirmDiscard() {
        new AlertDialog.Builder(this)
                .setTitle("Descartar a conferência?")
                .setMessage("A contagem feita até agora se perde e nada é alterado no estoque. "
                        + "Esta conferência não conta no limite do mês.")
                .setPositiveButton("Descartar", (dialog, which) -> {
                    repository.discard(session.uuid);
                    session = null;
                    reasons.clear();
                    renderScopeChooser();
                })
                .setNegativeButton("Continuar contando", null)
                .show();
    }

    // ---------------------------------------------- leitor de código de barras

    private void onScanRequested() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            cameraPermission.launch(android.Manifest.permission.CAMERA);
            return;
        }
        launchScanner();
    }

    private void launchScanner() {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.ALL_CODE_TYPES);
        options.setPrompt("Bipe o código do produto que você vai contar");
        options.setBeepEnabled(true);
        options.setBarcodeImageEnabled(false);
        options.setOrientationLocked(false);
        options.setCaptureActivity(ScannerActivity.class);
        scanLauncher.launch(options);
    }

    /**
     * Produto bipado. Numa contagem com leitor, o gesto natural é bipar a
     * mesma caixa várias vezes — uma por unidade. Por isso o padrão é somar 1
     * e seguir bipando; quem quiser pôr o número de uma vez usa "Outra
     * quantidade".
     */
    private void onBarcode(String code) {
        final ConferenceRepository.Item item = repository.findByCode(session, code);
        if (item == null) {
            toast("Código não encontrado neste escopo.");
            return;
        }

        double atual = item.counted == null ? 0d : item.counted;
        final double somado = atual + 1d;
        repository.count(session.uuid, item.productUuid, somado);
        renderCounting();

        new AlertDialog.Builder(this)
                .setTitle(item.name)
                .setMessage("Contado: " + CurrencyHelper.formatQuantity(somado)
                        + "   (no sistema: " + CurrencyHelper.formatQuantity(item.expected) + ")")
                .setPositiveButton("Bipar o próximo", (dialog, which) -> onScanRequested())
                .setNeutralButton("Outra quantidade", (dialog, which) -> promptQuantity(item))
                .setNegativeButton("Parar", null)
                .show();
    }

    private void promptQuantity(ConferenceRepository.Item item) {
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        field.setHint("quantidade contada");

        new AlertDialog.Builder(this)
                .setTitle(item.name)
                .setView(field)
                .setPositiveButton("Salvar", (dialog, which) -> {
                    double value = CurrencyHelper.parseCurrency(
                            field.getText().toString().trim(), -1d);
                    if (value < 0d) {
                        toast("Quantidade inválida.");
                        return;
                    }
                    repository.count(session.uuid, item.productUuid, value);
                    renderCounting();
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    // -------------------------------------------------- etapa 3: fechamento

    private void renderSummary() {
        showingSummary = true;
        container.removeAllViews();
        header.setVisibility(View.VISIBLE);
        search.setVisibility(View.GONE);
        filters.setVisibility(View.GONE);
        actions.setVisibility(View.VISIBLE);
        scanButton.setVisibility(View.GONE);

        ConferenceRepository.Summary summary = repository.summarize(session);
        progress.setText(summary.counted + " de " + summary.inScope + " conferidos");
        bar.setMax(Math.max(1, summary.inScope));
        bar.setProgress(summary.counted);
        partial.setText("");

        if (summary.counted == 0) {
            addText("Você ainda não contou nenhum item.", 15f, true, R.color.color_text);
            primaryButton.setText("Voltar a contar");
            primaryButton.setOnClickListener(v -> renderCounting());
            return;
        }

        // O número que faz a pessoa pagar vem primeiro, e grande.
        TextView headline = addText(headline(summary), 22f, true,
                summary.missingValue > summary.extraValue
                        ? R.color.color_error : R.color.color_text);
        headline.setPadding(0, 0, 0, dp(8));

        addText(summary.divergent + " item(ns) divergente(s) de " + summary.counted
                + " conferido(s), a preço de custo.", 14f, false, R.color.color_text_muted);
        if (summary.notCounted() > 0) {
            addSpace(6);
            addText(summary.notCounted() + " item(ns) não foram conferidos e ficam como estão — "
                    + "nada é zerado.", 14f, false, R.color.color_text_muted);
        }
        addSpace(20);

        if (!summary.divergentItems.isEmpty()) {
            addText("Por que a diferença?", 14f, true, R.color.color_text);
            addSpace(8);
        }
        for (ConferenceRepository.Item item : summary.divergentItems) {
            container.addView(buildDivergentCard(item));
        }

        primaryButton.setText("Aplicar ao estoque");
        primaryButton.setOnClickListener(v -> confirmApply(summary));
    }

    private String headline(ConferenceRepository.Summary summary) {
        if (summary.missingValue > 0d && summary.extraValue > 0d) {
            return "Faltam " + CurrencyHelper.formatCurrency(this, summary.missingValue)
                    + " · sobram " + CurrencyHelper.formatCurrency(this, summary.extraValue);
        }
        if (summary.missingValue > 0d) {
            return "Faltam " + CurrencyHelper.formatCurrency(this, summary.missingValue)
                    + " em mercadoria";
        }
        if (summary.extraValue > 0d) {
            return "Sobram " + CurrencyHelper.formatCurrency(this, summary.extraValue)
                    + " em mercadoria";
        }
        return "Estoque conferido, sem diferença";
    }

    private View buildDivergentCard(ConferenceRepository.Item item) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_surface);
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.bottomMargin = dp(10);
        card.setLayoutParams(cardParams);

        double delta = item.delta();
        TextView name = new TextView(this);
        name.setText((item.name == null ? "(sem nome)" : item.name)
                + "   " + (delta > 0 ? "+" : "") + CurrencyHelper.formatQuantity(delta));
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        name.setTypeface(name.getTypeface(), Typeface.BOLD);
        name.setTextColor(ContextCompat.getColor(this,
                delta < 0 ? R.color.color_error : R.color.color_success));
        card.addView(name);

        TextView detail = new TextView(this);
        detail.setText("sistema " + CurrencyHelper.formatQuantity(item.expected)
                + " · contado " + CurrencyHelper.formatQuantity(item.counted)
                + " · " + CurrencyHelper.formatCurrency(this, item.deltaValue()));
        detail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        detail.setTextColor(ContextCompat.getColor(this, R.color.color_text_muted));
        card.addView(detail);

        LinearLayout chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chips.setPadding(0, dp(10), 0, 0);
        for (String reason : REASONS) {
            TextView chip = new TextView(this);
            chip.setText(reason);
            chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            boolean selected = reason.equals(reasons.get(item.productUuid));
            chip.setBackgroundResource(R.drawable.bg_chip_toggle);
            chip.setSelected(selected);
            chip.setTextColor(ContextCompat.getColor(this,
                    selected ? R.color.color_text_on_brand : R.color.color_text));
            chip.setPadding(dp(12), dp(6), dp(12), dp(6));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            params.rightMargin = dp(8);
            chip.setLayoutParams(params);
            chip.setOnClickListener(v -> {
                if (reason.equals(reasons.get(item.productUuid))) {
                    reasons.remove(item.productUuid);
                } else {
                    reasons.put(item.productUuid, reason);
                }
                renderSummary();
            });
            chips.addView(chip);
        }

        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.addView(chips);
        card.addView(scroll);

        return card;
    }

    private void confirmApply(ConferenceRepository.Summary summary) {
        new AlertDialog.Builder(this)
                .setTitle("Aplicar ao estoque?")
                .setMessage(summary.divergent + " produto(s) terão a quantidade corrigida. "
                        + (summary.notCounted() > 0
                        ? summary.notCounted() + " item(ns) não conferidos ficam como estão. "
                        : "")
                        + "Cada correção vira uma movimentação de ajuste, que você pode cancelar depois.")
                .setPositiveButton("Aplicar", (dialog, which) -> apply(summary))
                .setNegativeButton("Voltar", null)
                .show();
    }

    private void apply(ConferenceRepository.Summary summary) {
        ConferenceRepository.ApplyResult result = repository.finish(session, reasons);

        Analytics.track(this, "conference.finished", Analytics.props(
                "scope_type", session.scopeType,
                "counted", summary.counted,
                "divergent", summary.divergent,
                "delta_value", summary.netValue(),
                "duration_ms", startedAtMillis > 0
                        ? System.currentTimeMillis() - startedAtMillis : 0));

        session = null;
        reasons.clear();

        if (!result.success) {
            toast(result.message == null ? "Alguns ajustes falharam." : result.message);
        } else {
            toast(result.applied + " produto(s) corrigido(s).");
        }
        renderScopeChooser();
    }

    // --------------------------------------------------------------- comuns

    private TextView addText(String text, float sizeSp, boolean bold, int colorRes) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(ContextCompat.getColor(this, colorRes));
        if (bold) {
            view.setTypeface(view.getTypeface(), Typeface.BOLD);
        }
        container.addView(view);
        return view;
    }

    private View addCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_message_warning);
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        container.addView(card);
        return card;
    }

    private void addSpace(int heightDp) {
        View space = new View(this);
        space.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(heightDp)));
        container.addView(space);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onBackPressed() {
        // Do fechamento, voltar é voltar a contar — não sair e perder o contexto.
        if (showingSummary) {
            renderCounting();
            return;
        }
        super.onBackPressed();
    }
}
