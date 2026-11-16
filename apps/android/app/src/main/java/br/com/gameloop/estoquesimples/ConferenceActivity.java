package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AlertDialog;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.data.ConferenceRepository;
import br.com.gameloop.estoquesimples.data.LocalDb;

/**
 * Conferência de estoque (ver docs/conferencia-de-estoque.md).
 *
 * Três etapas numa tela só: escolher o escopo, contar e fechar. O estado é
 * todo local e a sessão fica gravada a cada item, então sair da tela — ou o
 * app morrer — não perde contagem nenhuma.
 *
 * O limite do plano gratuito é verificado **antes** de contar qualquer coisa.
 * Avisar no fechamento, depois de a pessoa ter contado a loja inteira, é a
 * reclamação número um contra os concorrentes diretos; não vamos repeti-la.
 */
public class ConferenceActivity extends BaseActivity {

    private static final String TAG = "ConferenceActivity";

    private static final String[] REASONS = {"quebra", "furto", "erro de lançamento", "achado"};

    public static void open(Context context, String origin) {
        Intent intent = new Intent(context, ConferenceActivity.class);
        intent.putExtra("origem", origin);
        context.startActivity(intent);
    }

    private ConferenceRepository repository;
    private ConferenceRepository.Session session;
    private LinearLayout container;
    private TextView progress;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_conference);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Conferência de estoque");
        }

        container = findViewById(R.id.conferenceContainer);
        progress = findViewById(R.id.conferenceProgress);
        actions = findViewById(R.id.conferenceActions);
        scanButton = findViewById(R.id.conferenceScanButton);
        primaryButton = findViewById(R.id.conferencePrimaryButton);
        origin = getIntent() != null ? getIntent().getStringExtra("origem") : null;

        repository = new ConferenceRepository(LocalDb.open(this));

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
        progress.setVisibility(View.GONE);
        actions.setVisibility(View.GONE);

        boolean paid = PremiumManager.getInstance(this).hasPremiumAccess();
        int remaining = repository.freeRemainingThisMonth();

        if (!paid && remaining <= 0) {
            renderBlocked();
            return;
        }

        addText("Conte o que você tem de verdade e descubra, em reais, o que está faltando.", 15f, false);
        addSpace(16);

        if (!paid && remaining == 1) {
            // O aviso vem agora, antes de contar — nunca no fechamento.
            TextView warning = addText("Esta é a sua última conferência gratuita do mês. "
                    + "No plano gratuito são " + ConferenceRepository.FREE_MONTHLY_LIMIT + " por mês.", 14f, true);
            warning.setPadding(0, 0, 0, dp(16));
        }

        addText("O que você vai conferir?", 16f, true);
        addSpace(8);

        addScopeButton("Tudo", ConferenceRepository.SCOPE_ALL, null);
        addScopeGroup("Por categoria", ConferenceRepository.SCOPE_CATEGORY);
        addScopeGroup("Por local", ConferenceRepository.SCOPE_LOCATION);
        addScopeGroup("Por fornecedor", ConferenceRepository.SCOPE_SUPPLIER);
    }

    private void addScopeGroup(String label, String scopeType) {
        List<String> values = repository.scopeValues(scopeType);
        if (values.isEmpty()) {
            return;
        }
        addSpace(16);
        addText(label, 14f, true);
        addSpace(4);
        for (String value : values) {
            addScopeButton(value, scopeType, value);
        }
    }

    private void addScopeButton(String label, String scopeType, String scopeValue) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        button.setLayoutParams(params);
        button.setOnClickListener(v -> startSession(scopeType, scopeValue));
        container.addView(button);
    }

    private void renderBlocked() {
        addText("Você já fez as " + ConferenceRepository.FREE_MONTHLY_LIMIT
                + " conferências gratuitas deste mês.", 16f, true);
        addSpace(8);
        addText("No plano Equipe a conferência é ilimitada, com histórico para acompanhar "
                + "se a perda está subindo ou caindo.", 15f, false);
        addSpace(20);

        Button subscribe = new Button(this);
        subscribe.setText("Conhecer o plano Equipe");
        subscribe.setAllCaps(false);
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
        progress.setVisibility(View.VISIBLE);
        actions.setVisibility(View.VISIBLE);
        scanButton.setVisibility(View.VISIBLE);
        primaryButton.setText("Fechar conferência");
        primaryButton.setOnClickListener(v -> renderSummary());
        scanButton.setOnClickListener(v -> onScanRequested());

        List<ConferenceRepository.Item> items = repository.itemsInScope(session);
        int counted = 0;
        for (ConferenceRepository.Item item : items) {
            if (item.isCounted()) {
                counted++;
            }
            container.addView(buildCountRow(item));
        }
        progress.setText(counted + " de " + items.size() + " conferidos");

        if (items.isEmpty()) {
            addText("Nenhum produto neste escopo.", 15f, false);
        }
    }

    private View buildCountRow(ConferenceRepository.Item item) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, dp(10), 0, dp(10));

        TextView name = new TextView(this);
        name.setText(item.name == null ? "(sem nome)" : item.name);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        name.setTypeface(name.getTypeface(), android.graphics.Typeface.BOLD);
        row.addView(name);

        TextView expected = new TextView(this);
        String unit = item.unit == null || item.unit.trim().isEmpty() ? "" : " " + item.unit;
        expected.setText("No sistema: " + CurrencyHelper.formatQuantity(item.expected) + unit
                + (item.isCounted()
                ? "  ·  contado: " + CurrencyHelper.formatQuantity(item.counted)
                : "  ·  não conferido"));
        expected.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        row.addView(expected);

        LinearLayout input = new LinearLayout(this);
        input.setOrientation(LinearLayout.HORIZONTAL);
        input.setPadding(0, dp(6), 0, 0);

        EditText field = new EditText(this);
        field.setHint("quantidade contada");
        field.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        field.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        if (item.isCounted()) {
            field.setText(CurrencyHelper.formatQuantity(item.counted));
        }
        input.addView(field);

        Button save = new Button(this);
        save.setText("Ok");
        save.setAllCaps(false);
        save.setOnClickListener(v -> {
            String typed = field.getText().toString().trim();
            if (typed.isEmpty()) {
                repository.clearCount(session.uuid, item.productUuid);
            } else {
                double value = CurrencyHelper.parseCurrency(typed, -1d);
                if (value < 0d) {
                    toast("Quantidade inválida.");
                    return;
                }
                if (!repository.count(session.uuid, item.productUuid, value)) {
                    toast("Não foi possível registrar a contagem.");
                    return;
                }
            }
            renderCounting();
        });
        input.addView(save);
        row.addView(input);

        return row;
    }

    // ---------------------------------------------- leitor de código de barras

    private void onScanRequested() {
        if (androidx.core.content.ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.CAMERA)
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
     * Produto bipado: pergunta a quantidade na hora. Bipar e digitar é o ciclo
     * que se repete centenas de vezes numa contagem, então ele precisa caber
     * num diálogo só.
     */
    private void onBarcode(String code) {
        final ConferenceRepository.Item item = repository.findByCode(session, code);
        if (item == null) {
            toast("Código não encontrado neste escopo.");
            return;
        }

        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        field.setHint("quantidade contada");

        new AlertDialog.Builder(this)
                .setTitle(item.name)
                .setMessage("No sistema: " + CurrencyHelper.formatQuantity(item.expected))
                .setView(field)
                .setPositiveButton("Salvar", (dialog, which) -> {
                    double value = CurrencyHelper.parseCurrency(field.getText().toString().trim(), -1d);
                    if (value < 0d) {
                        toast("Quantidade inválida.");
                        return;
                    }
                    repository.count(session.uuid, item.productUuid, value);
                    renderCounting();
                    onScanRequested();
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }


    // -------------------------------------------------- etapa 3: fechamento

    private void renderSummary() {
        showingSummary = true;
        container.removeAllViews();
        actions.setVisibility(View.VISIBLE);
        scanButton.setVisibility(View.GONE);

        ConferenceRepository.Summary summary = repository.summarize(session);
        progress.setText(summary.counted + " de " + summary.inScope + " conferidos");

        if (summary.counted == 0) {
            addText("Você ainda não contou nenhum item.", 15f, true);
            primaryButton.setText("Voltar a contar");
            primaryButton.setOnClickListener(v -> renderCounting());
            return;
        }

        // O número que faz a pessoa pagar vem primeiro, e grande.
        TextView headline = addText(headline(summary), 20f, true);
        headline.setPadding(0, 0, 0, dp(8));

        addText(summary.divergent + " item(ns) divergente(s) de " + summary.counted
                + " conferido(s).", 15f, false);
        if (summary.notCounted() > 0) {
            addSpace(8);
            addText(summary.notCounted() + " item(ns) não foram conferidos e ficam como estão — "
                    + "nada é zerado.", 14f, false);
        }
        addSpace(20);

        for (ConferenceRepository.Item item : summary.divergentItems) {
            container.addView(buildDivergentRow(item));
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

    private View buildDivergentRow(ConferenceRepository.Item item) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, dp(10), 0, dp(10));

        TextView name = new TextView(this);
        double delta = item.delta();
        name.setText((item.name == null ? "(sem nome)" : item.name)
                + "   " + (delta > 0 ? "+" : "") + CurrencyHelper.formatQuantity(delta));
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        name.setTypeface(name.getTypeface(), android.graphics.Typeface.BOLD);
        row.addView(name);

        TextView detail = new TextView(this);
        detail.setText("sistema " + CurrencyHelper.formatQuantity(item.expected)
                + " · contado " + CurrencyHelper.formatQuantity(item.counted)
                + " · " + CurrencyHelper.formatCurrency(this, item.deltaValue()));
        detail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        row.addView(detail);

        // Motivo da divergência: é o que transforma um susto único numa
        // métrica de perdas que se acompanha mês a mês.
        LinearLayout chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chips.setPadding(0, dp(6), 0, 0);
        for (String reason : REASONS) {
            Button chip = new Button(this);
            chip.setText(reason);
            chip.setAllCaps(false);
            chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
            boolean selected = reason.equals(reasons.get(item.productUuid));
            chip.setAlpha(selected ? 1f : 0.45f);
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

        android.widget.HorizontalScrollView scroll = new android.widget.HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.addView(chips);
        row.addView(scroll);

        return row;
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

    private TextView addText(String text, float sizeSp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        if (bold) {
            view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        }
        container.addView(view);
        return view;
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
