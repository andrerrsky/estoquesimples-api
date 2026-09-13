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

    private static final String[] FILTROS_TIPO = {"Todas", "Entradas", "Saídas", "Ajustes e correções"};

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

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        getSupportActionBar().setTitle(R.string.history_title);

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
        ArrayAdapter<String> typeAdapter = new ArrayAdapter<>(
                this, android.R.layout.simple_spinner_item, FILTROS_TIPO);
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
        String buscaLower = searchQuery.toLowerCase(Locale.ROOT);

        List<HistoryAdapter.HistoryItem> visiveis = new ArrayList<>();
        for (HistoryAdapter.HistoryItem item : allItems) {
            boolean casaTipo = semFiltroTipo || filtroTipo.equals(categoria(item.getType()));
            boolean casaBusca = buscaLower.isEmpty()
                    || (item.getProductName() != null
                        && item.getProductName().toLowerCase(Locale.ROOT).contains(buscaLower));
            if (casaTipo && casaBusca) {
                visiveis.add(item);
            }
        }

        boolean filtroAtivo = !semFiltroTipo || !buscaLower.isEmpty();
        emptyView.setText(filtroAtivo && !allItems.isEmpty()
                ? "Nenhuma movimentação encontrada para esse filtro"
                : "Nenhuma movimentação de entrada ou saída registrada ainda");

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
                    "SELECT uuid, product_name, change_type, quantity, timestamp, note, "
                            + "reverses_uuid "
                            + "FROM EstoqueHistorico WHERE deleted_at IS NULL "
                            + "ORDER BY timestamp DESC",
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

                    items.add(new HistoryAdapter.HistoryItem(
                            uuid, product, type, qty, ts, note, reversesUuid));
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

        allItems.clear();
        allItems.addAll(items);
        applyFilters();
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

        StringBuilder sb = new StringBuilder();
        sb.append("Produto: ").append(item.getProductName()).append("\n");
        sb.append("Tipo: ").append(MovementDisplay.sentenceLabel(item.getType())).append("\n");
        sb.append("Quantidade: ")
                .append(MovementDisplay.sign(item.getType(), item.getQuantity()))
                .append(CurrencyHelper.formatQuantity(Math.abs(item.getQuantity())))
                .append("\n");
        sb.append("Data: ").append(dateStr);

        String note = item.getNote();
        if (note != null && !note.isEmpty() && !"null".equalsIgnoreCase(note)) {
            sb.append("\n\nObservações / Informações adicionais:\n").append(note);
        }

        if (item.getReversesUuid() != null) {
            HistoryAdapter.HistoryItem original = findByUuid(item.getReversesUuid());
            sb.append("\n\nEsta movimentação estorna: ").append(descreverVinculo(original));
        }
        HistoryAdapter.HistoryItem estorno = findReversalOf(item.getUuid());
        if (estorno != null) {
            sb.append("\n\nEsta movimentação foi estornada em: ").append(descreverVinculo(estorno));
        }

        androidx.appcompat.app.AlertDialog.Builder builder =
                new androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("Detalhes da movimentação")
                        .setMessage(sb.toString())
                        .setPositiveButton("OK", null);

        if (canCancel(item)) {
            builder.setNegativeButton("Cancelar movimentação",
                    (dialog, which) -> confirmCancellation(item));
        }

        builder.show();
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

    private String descreverVinculo(HistoryAdapter.HistoryItem item) {
        if (item == null) {
            // Pode não ter chegado ainda por sincronização, ou pertencer a um
            // produto excluído há muito tempo — o vínculo continua verdadeiro
            // mesmo sem os detalhes para mostrar aqui.
            return "movimentação não encontrada neste aparelho";
        }
        String dateStr = new java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.getDefault())
                .format(new java.util.Date(item.getTimestamp()));
        return MovementDisplay.sentenceLabel(item.getType()) + " de "
                + CurrencyHelper.formatQuantity(Math.abs(item.getQuantity())) + " em " + dateStr;
    }

    /**
     * O cancelamento em si não pode ser cancelado: seria uma cadeia de eventos
     * que se anulam sem que o usuário consiga acompanhar o efeito. Movimentações
     * legadas sem uuid também ficam de fora, porque não há como endereçá-las.
     * Uma movimentação já estornada também não oferece o botão de novo — sem
     * isso, o toque só resultava num aviso de "já foi cancelada".
     */
    private boolean canCancel(HistoryAdapter.HistoryItem item) {
        return item.getUuid() != null
                && !item.isReversed()
                && !MovementRepository.CANCELAMENTO.equalsIgnoreCase(item.getType());
    }

    private void confirmCancellation(HistoryAdapter.HistoryItem item) {
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Cancelar movimentação")
                .setMessage("O registro original permanece no histórico e uma movimentação "
                        + "de correção será criada para desfazer o efeito no estoque.\n\n"
                        + "Deseja continuar?")
                .setNegativeButton("Voltar", null)
                .setPositiveButton("Cancelar movimentação", (dialog, which) -> applyCancellation(item))
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
                    .cancel(item.getUuid(), "Cancelamento de " + MovementDisplay
                            .sentenceLabel(item.getType()).toLowerCase());
        }

        if (!result.success) {
            Toast.makeText(this, result.message, Toast.LENGTH_LONG).show();
            return;
        }

        if (MainActivity.instance != null) {
            MainActivity.instance.markListDirty(true);
        }
        Toast.makeText(this, "Movimentação cancelada.", Toast.LENGTH_SHORT).show();
        loadHistory();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.options_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int itemId = item.getItemId();
        
        if (itemId == android.R.id.home) {
            onBackPressed();
            return true;
        } else if (itemId == R.id.menu_analytics) {
            Intent intent = new Intent(this, AnalyticsActivity.class);
            startActivity(intent);
            return true;
        } else if (itemId == R.id.menu_about) {
            MainActivity.instance.showAboutActivity();
            return true;
        } else if (itemId == R.id.menu_settings) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}


