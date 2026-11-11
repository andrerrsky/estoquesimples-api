package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.ReorderPlanner;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Lista de reposição (versão 31).
 *
 * Junta o que está acabando por fornecedor, sugere quanto pedir e monta a
 * mensagem para mandar pelo WhatsApp (ou qualquer app de mensagem). A pessoa
 * ajusta a quantidade ou desmarca o que não quer antes de enviar.
 *
 * Grátis: é uso de todo dia e faz o estoque mínimo e o fornecedor, que já
 * eram cadastrados, servirem para alguma coisa.
 */
public class ReorderActivity extends BaseActivity {

    private static final String TAG = "ReorderActivity";

    /**
     * Teto de itens na tela. A lista é montada com views simples, e um estoque
     * com milhares de produtos zerados (planilha importada sem quantidade)
     * travaria a tela; ninguém faz um pedido de 6.000 itens pelo WhatsApp.
     */
    static final int MAX_ITEMS = 300;
    private int hiddenItems;

    public static void open(Context context, String origin) {
        Intent intent = new Intent(context, ReorderActivity.class);
        intent.putExtra("origem", origin);
        context.startActivity(intent);
    }

    private LinearLayout container;
    private int totalFound;
    private Map<String, List<ReorderPlanner.Item>> groups;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_reorder);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Lista de reposição");
        }
        container = findViewById(R.id.reorderContainer);
        String origem = getIntent() != null ? getIntent().getStringExtra("origem") : null;

        List<ReorderPlanner.Item> items = ReorderPlanner.mostUrgent(loadItems(), MAX_ITEMS);
        hiddenItems = Math.max(0, totalFound - items.size());
        groups = ReorderPlanner.bySupplier(items);
        Analytics.track(this, "reorder.viewed", Analytics.props(
                "origin", origem == null ? "menu" : origem,
                "items", items.size(),
                "suppliers", groups.size()));
        render();
    }

    @Override
    public boolean onSupportNavigateUp() {
        finish();
        return true;
    }

    private List<ReorderPlanner.Item> loadItems() {
        List<ReorderPlanner.Item> items = new ArrayList<>();
        if (!ensureDatabaseAvailable()) {
            return items;
        }
        Cursor c = null;
        try {
            c = MainActivity.stock.rawQuery(
                    "SELECT name, unit, amount, min_stock, supplier FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS,
                    null);
            while (c.moveToNext()) {
                double amount = CurrencyHelper.parseCurrency(c.getString(2), 0);
                double min = CurrencyHelper.parseCurrency(c.getString(3), 0);
                if (ReorderPlanner.needsReorder(amount, min)) {
                    items.add(new ReorderPlanner.Item(c.getString(0), c.getString(1), amount, min, c.getString(4)));
                }
            }
            totalFound = items.size();
        } catch (Exception e) {
            Log.e(TAG, "falha ao montar a lista de reposição", e);
        } finally {
            LocalDb.closeQuietly(c);
        }
        return items;
    }

    private void render() {
        container.removeAllViews();
        if (groups.isEmpty()) {
            TextView vazio = text("Nada para repor agora. 🎉\n\nQuando um produto chegar no estoque mínimo "
                    + "(ou zerar), ele aparece aqui, separado por fornecedor, com o pedido pronto "
                    + "para mandar no WhatsApp.\n\nDica: cadastre o estoque mínimo e o fornecedor "
                    + "de cada produto na edição.", R.style.TextAppearance_Estoque_Supporting);
            container.addView(vazio);
            return;
        }

        int total = 0;
        for (List<ReorderPlanner.Item> lista : groups.values()) total += lista.size();
        TextView resumo = text(Texto.plural(total, "produto precisa", "produtos precisam") + " de reposição"
                + " · " + Texto.plural(groups.size(), "fornecedor", "fornecedores")
                + (hiddenItems > 0 ? " (mostrando os " + MAX_ITEMS + " mais urgentes; "
                        + hiddenItems + " ficaram de fora)" : "")
                + "\nA quantidade sugerida leva o estoque ao dobro do mínimo. Ajuste à vontade.",
                R.style.TextAppearance_Estoque_Supporting);
        container.addView(resumo);

        for (Map.Entry<String, List<ReorderPlanner.Item>> grupo : groups.entrySet()) {
            container.addView(supplierCard(grupo.getKey(), grupo.getValue()));
        }

        Button todos = new Button(this, null, 0, R.style.Widget_Estoque_Button_Secondary);
        todos.setText("Compartilhar a lista completa");
        todos.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        todos.setLayoutParams(lp);
        todos.setOnClickListener(v -> share(ReorderPlanner.fullList(groups), "todos"));
        container.addView(todos);
    }

    private View supplierCard(String supplier, List<ReorderPlanner.Item> items) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_surface);
        int pad = dp(16);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        card.setLayoutParams(params);

        card.addView(text(supplier, R.style.TextAppearance_Estoque_Title));

        for (ReorderPlanner.Item item : items) {
            card.addView(itemRow(item));
        }

        Button enviar = new Button(this, null, 0, R.style.Widget_Estoque_Button_Primary);
        enviar.setText(ReorderPlanner.SEM_FORNECEDOR.equals(supplier)
                ? "Enviar lista pelo WhatsApp" : "Enviar pedido pelo WhatsApp");
        enviar.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        enviar.setLayoutParams(lp);
        enviar.setOnClickListener(v -> {
            String nome = SessionManager.get(this).workspaceName();
            String mensagem = ReorderPlanner.message(supplier, items, nome);
            if (mensagem == null) {
                Toast.makeText(this, "Marque ao menos um produto.", Toast.LENGTH_SHORT).show();
                return;
            }
            share(mensagem, "fornecedor");
        });
        card.addView(enviar);
        return card;
    }

    private View itemRow(ReorderPlanner.Item item) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(6), 0, 0);

        CheckBox check = new CheckBox(this);
        check.setChecked(item.selected);
        String situacao = item.amount <= 0
                ? "zerado"
                : "tem " + CurrencyHelper.formatQuantity(item.amount)
                        + (item.minStock > 0 ? " · mín. " + CurrencyHelper.formatQuantity(item.minStock) : "");
        check.setText(item.name + "\n" + situacao);
        check.setTextColor(ContextCompat.getColor(this, R.color.color_text));
        check.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        check.setOnCheckedChangeListener((b, marcado) -> item.selected = marcado);
        row.addView(check);

        EditText qtd = new EditText(this);
        qtd.setText(ReorderPlanner.formatQuantity(item.quantity));
        qtd.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        qtd.setSelectAllOnFocus(true);
        qtd.setMinEms(3);
        qtd.setGravity(Gravity.END);
        qtd.setContentDescription("Quantidade a pedir de " + item.name);
        qtd.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                item.quantity = CurrencyHelper.parseCurrency(s.toString(), 0);
            }
        });
        row.addView(qtd);

        TextView unidade = text(" " + item.unit, R.style.TextAppearance_Estoque_Supporting);
        unidade.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        row.addView(unidade);
        return row;
    }

    /** Abre o seletor de apps (WhatsApp aparece primeiro para quem usa). */
    private void share(String mensagem, String tipo) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, mensagem);
        try {
            startActivity(Intent.createChooser(send, "Enviar pedido"));
            Analytics.track(this, "reorder.shared", Analytics.props("kind", tipo));
        } catch (Exception e) {
            Toast.makeText(this, "Nenhum app de mensagem encontrado.", Toast.LENGTH_SHORT).show();
        }
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
