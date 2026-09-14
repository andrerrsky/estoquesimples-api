package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;

import android.content.Intent;
import android.database.Cursor;
import android.os.Bundle;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.widget.ArrayAdapter;
import android.widget.AdapterView;
import android.widget.ListView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.widget.SearchView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class HistoryActivity extends BaseActivity {

    // Por efeito no saldo, não pelo nome do tipo: quem quer "tudo que saiu do
    // estoque" precisa ver também o estorno de uma entrada.
    private static final String[] FILTROS_TIPO = {"Todas", "Aumentaram o estoque", "Diminuíram o estoque", "Ajustes e estornos"};

    private ListView historyList;
    private SearchView searchView;
    private Spinner typeFilter;
    private TextView emptyView;

    /** Tudo o que veio do banco, antes de aplicar busca/filtro de tipo. */
    private final List<HistoryAdapter.HistoryItem> allItems = new ArrayList<>();
    private String searchQuery = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_history);

        getSupportActionBar().setTitle(R.string.history_title);
        SectionNav.attach(this, R.id.navigation_history);

        historyList = (ListView) findViewById(R.id.historyList);
        emptyView = (TextView) findViewById(R.id.emptyHistory);
        historyList.setEmptyView(emptyView);

        searchView = findViewById(R.id.historySearchView);
        searchView.setOnQueryTextListener(new SearchView.OnQueryTextListener() {
            @Override
            public boolean onQueryTextSubmit(String query) {
                return true;
            }

            @Override
            public boolean onQueryTextChange(String newText) {
                searchQuery = newText == null ? "" : newText.trim();
                applyFilters();
                return true;
            }
        });

        typeFilter = findViewById(R.id.historyTypeFilter);
        // A caixa fechada mostra "Tipo: Todas": uma caixa só com "Todas" não
        // parecia um filtro.
        ArrayAdapter<String> typeAdapter = new ArrayAdapter<String>(
                this, android.R.layout.simple_spinner_item, FILTROS_TIPO) {
            @Override
            public android.view.View getView(int position, android.view.View convertView, android.view.ViewGroup parent) {
                android.view.View v = super.getView(position, convertView, parent);
                ((TextView) v).setText("Tipo: " + getItem(position));
                return v;
            }
        };
        typeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        typeFilter.setAdapter(typeAdapter);
        typeFilter.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, android.view.View view, int position, long id) {
                applyFilters();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });

        loadHistory();
    }

    private static boolean casaFiltro(String filtro, HistoryAdapter.HistoryItem item) {
        double efeito = MovementRepository.signedQuantity(item.getType(), item.getQuantity());
        if (FILTROS_TIPO[1].equals(filtro)) return efeito > 0;
        if (FILTROS_TIPO[2].equals(filtro)) return efeito < 0;
        if (FILTROS_TIPO[3].equals(filtro)) return "Ajustes e correções".equals(categoria(item.getType()));
        return true;
    }

    /** Categoria de exibição do tipo, para casar com as opções do filtro. */
    private static String categoria(String changeType) {
        if (changeType == null) {
            return "Entradas";
        }
        String tipo = changeType.toLowerCase(Locale.ROOT);
        if (MovementRepository.SAIDA.equalsIgnoreCase(tipo) || "venda".equalsIgnoreCase(tipo)) {
            return "Saídas";
        }
        if (MovementRepository.AJUSTE.equalsIgnoreCase(tipo)
                || MovementRepository.EDICAO.equalsIgnoreCase(tipo)
                || MovementRepository.CANCELAMENTO.equalsIgnoreCase(tipo)) {
            return "Ajustes e correções";
        }
        return "Entradas";
    }

    private void applyFilters() {
        String filtroTipo = (String) typeFilter.getSelectedItem();
        boolean semFiltroTipo = filtroTipo == null || FILTROS_TIPO[0].equals(filtroTipo);
        String buscaLower = MainActivity.fold(searchQuery);

        List<HistoryAdapter.HistoryItem> visiveis = new ArrayList<>();
        for (HistoryAdapter.HistoryItem item : allItems) {
            boolean casaTipo = semFiltroTipo || casaFiltro(filtroTipo, item);
            // Mesma regra da Início: sem acento, sem caixa ("moida" acha "Moída").
            boolean casaBusca = buscaLower.isEmpty()
                    || MainActivity.fold(item.getProductName()).contains(buscaLower);
            if (casaTipo && casaBusca) {
                visiveis.add(item);
            }
        }

        String vazio;
        if (allItems.isEmpty()) {
            vazio = "Nenhuma movimentação registrada ainda. Entradas, saídas e ajustes aparecem aqui.";
        } else if (!buscaLower.isEmpty()) {
            vazio = "Nenhuma movimentação de \u201c" + searchQuery.trim() + "\u201d"
                    + (semFiltroTipo ? "." : " em \u201c" + filtroTipo + "\u201d.");
        } else {
            vazio = "Nenhuma movimentação em \u201c" + filtroTipo + "\u201d.";
        }
        emptyView.setText(vazio);

        historyList.setAdapter(new HistoryAdapter(this, visiveis));
        historyList.setOnItemClickListener((parent, view, position, id) -> {
            Object obj = parent.getItemAtPosition(position);
            if (obj instanceof HistoryAdapter.HistoryItem) {
                showHistoryDetail((HistoryAdapter.HistoryItem) obj);
            }
        });
    }

    private void loadHistory() {
        List<HistoryAdapter.HistoryItem> items = new ArrayList<>();

        // Garantir que o banco de dados esteja inicializado antes de consultar.
        // Evita NullPointerException quando a Activity é recriada após a morte
        // do processo e MainActivity.stock ainda está nulo.
        if (!ensureDatabaseAvailable()) {
            Log.e("HistoryActivity", "Database not available, cannot load history");
            Toast.makeText(this, "Não foi possível carregar o histórico no momento.", Toast.LENGTH_LONG).show();
            allItems.clear();
            applyFilters();
            return;
        }

        Cursor cursor = null;
        try {
            cursor = MainActivity.stock.rawQuery(
                    "SELECT h.uuid, h.product_name, h.change_type, h.quantity, h.timestamp, h.note, "
                            + "h.reverses_uuid, "
                            + "(SELECT e.unit FROM Estoque e WHERE e.uuid = h.product_uuid) AS unit, "
                            + "h.product_uuid, h.updated_at, "
                            + "(SELECT e.deleted_at FROM Estoque e WHERE e.uuid = h.product_uuid) AS product_deleted "
                            + "FROM EstoqueHistorico h WHERE h.deleted_at IS NULL "
                            + "ORDER BY h.timestamp DESC",
                    null
            );

            if (cursor != null && cursor.moveToFirst()) {
                do {
                    String uuid = cursor.getString(0);
                    String product = cursor.getString(1);
                    String type = cursor.getString(2);
                    double qty = cursor.getDouble(3);
                    long ts = cursor.getLong(4);
                    String note = cursor.getString(5);
                    String reversesUuid = cursor.getString(6);
                    String unit = cursor.getString(7);

                    HistoryAdapter.HistoryItem item = new HistoryAdapter.HistoryItem(
                            uuid, product, type, qty, ts, note, reversesUuid);
                    item.setUnit(unit);
                    item.setProductUuid(cursor.getString(8));
                    item.setRecordedAt(cursor.isNull(9) ? 0L : cursor.getLong(9));
                    item.setProductDeleted(!cursor.isNull(10));
                    items.add(item);
                } while (cursor.moveToNext());
            }
        } catch (Exception e) {
            Log.e("HistoryActivity", "Error loading history", e);
            Toast.makeText(this, "Erro ao carregar o histórico.", Toast.LENGTH_LONG).show();
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Exception ignored) {}
            }
        }

        marcarEstornadas(items);
        calcularSaldos(items);

        allItems.clear();
        allItems.addAll(items);
        applyFilters();
    }

    /**
     * "Ficou com quanto?" depois de cada movimentação. O histórico não guarda
     * saldo; ele é refeito de trás para frente a partir do saldo atual de cada
     * produto, desfazendo o efeito de cada movimentação mais nova.
     */
    private void calcularSaldos(List<HistoryAdapter.HistoryItem> items) {
        java.util.Map<String, Double> saldo = new java.util.HashMap<>();
        Cursor c = null;
        try {
            c = MainActivity.stock.rawQuery("SELECT uuid, amount FROM Estoque WHERE uuid IS NOT NULL", null);
            while (c != null && c.moveToNext()) {
                saldo.put(c.getString(0), CurrencyHelper.parseCurrency(c.getString(1), 0));
            }
        } catch (Exception e) {
            Log.e("HistoryActivity", "Error computing balances", e);
            return;
        } finally {
            if (c != null) {
                try {
                    c.close();
                } catch (Exception ignored) {}
            }
        }
        // items vêm do mais novo para o mais antigo
        for (HistoryAdapter.HistoryItem item : items) {
            String pid = item.getProductUuid();
            if (pid == null || !saldo.containsKey(pid)) {
                continue;
            }
            double depois = saldo.get(pid);
            item.setBalanceAfter(depois);
            saldo.put(pid, depois - MovementRepository.signedQuantity(item.getType(), item.getQuantity()));
        }
    }

    /**
     * Garante que o banco de dados está disponível e aberto, tentando
     * reinicializá-lo se necessário (process death, navegação direta, etc.).
     */
    private boolean ensureDatabaseAvailable() {
        try {
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }

            if (MainActivity.instance != null) {
                MainActivity.instance.openOrCreateDB();
                if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                    return true;
                }
            }

            // Última tentativa: abrir o banco diretamente a partir desta Activity
            MainActivity.stock = LocalDb.open(this);
            return MainActivity.stock != null && MainActivity.stock.isOpen();
        } catch (Exception e) {
            Log.e("HistoryActivity", "Error ensuring database availability", e);
            return false;
        }
    }

    /**
     * Exibe um diálogo com o detalhamento completo da movimentação,
     * incluindo as observações/informações adicionais registradas na saída.
     */
    private void showHistoryDetail(HistoryAdapter.HistoryItem item) {
        String dateStr = new java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.getDefault())
                .format(new java.util.Date(item.getTimestamp()));

        // Rótulos em negrito e uma linha por informação: o bloco de texto
        // corrido era a parte menos legível do Histórico.
        StringBuilder sb = new StringBuilder();
        sb.append("<b>Produto</b><br>").append(esc(item.getProductName())).append("<br><br>");
        sb.append("<b>Tipo</b><br>").append(esc(MovementDisplay.sentenceLabel(item.getType()))).append("<br><br>");
        String unidade = item.getUnit().isEmpty() ? "" : " " + item.getUnit();
        double efeito = MovementRepository.signedQuantity(item.getType(), item.getQuantity());
        sb.append("<b>Quantidade</b><br>")
                .append(CurrencyHelper.formatQuantity(Math.abs(item.getQuantity())))
                .append(esc(unidade))
                .append(efeito < 0 ? " (saiu do estoque)" : efeito > 0 ? " (entrou no estoque)" : "")
                .append("<br><br>");
        sb.append("<b>Data</b><br>").append(dateStr);
        if (item.hasBalanceAfter()) {
            sb.append("<br><br><b>Estoque depois</b><br>")
                    .append(CurrencyHelper.formatQuantity(item.getBalanceAfter())).append(esc(unidade));
        }

        String note = item.getNote();
        if (note != null && !note.isEmpty() && !"null".equalsIgnoreCase(note)) {
            sb.append("<br><br><b>Observação</b><br>").append(esc(note));
        }

        if (item.getReversesUuid() != null) {
            HistoryAdapter.HistoryItem original = findByUuid(item.getReversesUuid());
            sb.append("<br><br><b>Estorna</b><br>").append(esc(descreverVinculo(original)));
        }
        HistoryAdapter.HistoryItem estorno = findReversalOf(item.getUuid());
        if (estorno != null) {
            sb.append("<br><br><b>Estornada por</b><br>").append(esc(descreverVinculo(estorno)));
        }

        androidx.appcompat.app.AlertDialog.Builder builder =
                new androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("Detalhes da movimentação")
                        .setMessage(androidx.core.text.HtmlCompat.fromHtml(sb.toString(),
                                androidx.core.text.HtmlCompat.FROM_HTML_MODE_LEGACY))
                        .setPositiveButton("OK", null);

        if (canCancel(item)) {
            builder.setNegativeButton("Estornar",
                    (dialog, which) -> confirmCancellation(item));
        }
        final List<HistoryAdapter.HistoryItem> lote = loteDoMesmoAjuste(item);
        if (lote.size() > 1) {
            builder.setNeutralButton("Estornar todos (" + lote.size() + ")",
                    (dialog, which) -> confirmBatchCancellation(lote));
        }

        androidx.appcompat.app.AlertDialog dialog = builder.show();
        android.widget.Button estornar = dialog.getButton(androidx.appcompat.app.AlertDialog.BUTTON_NEGATIVE);
        if (estornar != null) {
            // Ação que mexe no saldo: destacada em vermelho e com verbo próprio,
            // para não ser lida como "fechar" ao lado do OK.
            estornar.setTextColor(androidx.core.content.ContextCompat.getColor(this, R.color.color_error));
        }
    }

    /**
     * Marca, na própria lista recém-carregada, quem foi estornado por outra
     * movimentação — para a lista mostrar isso de relance, sem precisar abrir
     * o detalhe de cada item para descobrir que ele não vale mais para o
     * saldo atual.
     */
    private void marcarEstornadas(List<HistoryAdapter.HistoryItem> items) {
        java.util.Set<String> estornadas = new java.util.HashSet<>();
        for (HistoryAdapter.HistoryItem item : items) {
            if (item.getReversesUuid() != null) {
                estornadas.add(item.getReversesUuid());
            }
        }
        if (estornadas.isEmpty()) {
            return;
        }
        for (HistoryAdapter.HistoryItem item : items) {
            if (estornadas.contains(item.getUuid())) {
                item.markReversed();
            }
        }
    }

    /** Busca em {@link #allItems}, não filtrado — o vínculo existe mesmo que a outra ponta esteja fora do filtro atual. */
    private HistoryAdapter.HistoryItem findByUuid(String uuid) {
        if (uuid == null) {
            return null;
        }
        for (HistoryAdapter.HistoryItem candidato : allItems) {
            if (uuid.equals(candidato.getUuid())) {
                return candidato;
            }
        }
        return null;
    }

    /** O item, se houver, cujo {@code reverses_uuid} aponta para {@code uuid}. */
    private HistoryAdapter.HistoryItem findReversalOf(String uuid) {
        if (uuid == null) {
            return null;
        }
        for (HistoryAdapter.HistoryItem candidato : allItems) {
            if (uuid.equals(candidato.getReversesUuid())) {
                return candidato;
            }
        }
        return null;
    }

    private static String esc(String text) {
        return android.text.TextUtils.htmlEncode(text == null ? "" : text);
    }

    private String descreverVinculo(HistoryAdapter.HistoryItem item) {
        if (item == null) {
            // Pode não ter chegado ainda por sincronização, ou pertencer a um
            // produto excluído há muito tempo — o vínculo continua verdadeiro
            // mesmo sem os detalhes para mostrar aqui.
            return "movimentação não encontrada neste aparelho";
        }
        String dateStr = new java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.getDefault())
                .format(new java.util.Date(item.getTimestamp()));
        String unidade = item.getUnit().isEmpty() ? "" : " " + item.getUnit();
        return MovementDisplay.sentenceLabel(item.getType()) + " de "
                + CurrencyHelper.formatQuantity(Math.abs(item.getQuantity())) + unidade + " em " + dateStr;
    }

    /**
     * O cancelamento em si não pode ser cancelado: seria uma cadeia de eventos
     * que se anulam sem que o usuário consiga acompanhar o efeito. Movimentações
     * legadas sem uuid também ficam de fora, porque não há como endereçá-las.
     * Uma movimentação já estornada também não oferece o botão de novo — sem
     * isso, o toque só resultava num aviso de "já foi cancelada".
     */
    /**
     * Movimentações do mesmo ajuste em massa (mesma nota "Ajuste em massa
     * dd/MM HH:mm (+N)") ainda não estornadas. Reverter um a um era o jeito
     * mais caro de corrigir o erro mais caro.
     */
    private List<HistoryAdapter.HistoryItem> loteDoMesmoAjuste(HistoryAdapter.HistoryItem item) {
        List<HistoryAdapter.HistoryItem> lote = new ArrayList<>();
        String nota = item.getNote();
        if (nota == null || !nota.startsWith("Ajuste em massa ")) {
            return lote;
        }
        for (HistoryAdapter.HistoryItem outro : allItems) {
            if (nota.equals(outro.getNote()) && canCancel(outro)) {
                lote.add(outro);
            }
        }
        return lote;
    }

    private void confirmBatchCancellation(List<HistoryAdapter.HistoryItem> lote) {
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Estornar o ajuste em massa?")
                .setMessage(lote.size() + " movimentações deste ajuste serão estornadas de uma vez. "
                        + "Os registros originais ficam no histórico.")
                .setNegativeButton("Voltar", null)
                .setPositiveButton("Estornar todos", (d, w) -> {
                    if (!ensureDatabaseAvailable()) return;
                    int ok = 0;
                    synchronized (MainActivity.DB_LOCK) {
                        MovementRepository repo = new MovementRepository(MainActivity.stock);
                        for (HistoryAdapter.HistoryItem it : lote) {
                            if (repo.cancel(it.getUuid(), "Estorno do ajuste em massa").success) ok++;
                        }
                    }
                    if (MainActivity.instance != null) {
                        MainActivity.instance.markListDirty(true);
                    }
                    Feedback.show(this, "Ajuste em massa estornado em " + Texto.plural(ok, "produto", "produtos") + ".");
                    loadHistory();
                })
                .show();
    }

    private boolean canCancel(HistoryAdapter.HistoryItem item) {
        return item.getUuid() != null
                && !item.isReversed()
                && !MovementRepository.CANCELAMENTO.equalsIgnoreCase(item.getType());
    }

    private void confirmCancellation(HistoryAdapter.HistoryItem item) {
        // "Estoque atual X → ficará Y": quem já corrigiu o saldo na mão depois
        // desta movimentação acabava com estoque dobrado sem perceber.
        String efeito = "";
        String alerta = "";
        String pid = item.getProductUuid();
        if (pid != null && ensureDatabaseAvailable()) {
            double atual = new br.com.gameloop.estoquesimples.data.ProductRepository(MainActivity.stock).currentAmount(pid);
            double depois = atual - MovementRepository.signedQuantity(item.getType(), item.getQuantity());
            String un = item.getUnit().isEmpty() ? "" : " " + item.getUnit();
            efeito = "\n\nEstoque atual: " + CurrencyHelper.formatQuantity(atual) + un
                    + " → ficará: " + CurrencyHelper.formatQuantity(Math.max(0, depois)) + un;
            for (HistoryAdapter.HistoryItem outro : allItems) {
                if (pid.equals(outro.getProductUuid()) && outro.getTimestamp() > item.getTimestamp()
                        && (MovementRepository.AJUSTE.equalsIgnoreCase(outro.getType())
                        || MovementRepository.EDICAO.equalsIgnoreCase(outro.getType()))) {
                    alerta = "\n\nAtenção: houve um ajuste manual neste produto depois desta movimentação. "
                            + "Se ele já corrigiu o saldo, estornar vai contar duas vezes.";
                    break;
                }
            }
        }
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Estornar movimentação?")
                .setMessage(descreverVinculo(item) + "\n" + item.getProductName() + efeito + alerta + "\n\n"
                        + "O registro original permanece no histórico e uma movimentação "
                        + "de correção será criada para desfazer o efeito no estoque.")
                .setNegativeButton("Voltar", null)
                .setPositiveButton("Estornar", (dialog, which) -> applyCancellation(item))
                .show();
    }

    private void applyCancellation(HistoryAdapter.HistoryItem item) {
        if (!ensureDatabaseAvailable()) {
            Toast.makeText(this, "Banco de dados não disponível.", Toast.LENGTH_SHORT).show();
            return;
        }

        MovementRepository.Result result;
        synchronized (MainActivity.DB_LOCK) {
            result = new MovementRepository(MainActivity.stock)
                    .cancel(item.getUuid(), "Estorno de " + MovementDisplay
                            .sentenceLabel(item.getType()).toLowerCase());
        }

        if (!result.success) {
            Toast.makeText(this, result.message, Toast.LENGTH_LONG).show();
            return;
        }

        if (MainActivity.instance != null) {
            MainActivity.instance.markListDirty(true);
        }
        Feedback.show(this, "Movimentação estornada.");
        loadHistory();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.section_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return AppMenu.handle(this, item) || super.onOptionsItemSelected(item);
    }
}
