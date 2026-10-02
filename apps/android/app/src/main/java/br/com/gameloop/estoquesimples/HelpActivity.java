package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.AbsListView;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import androidx.core.view.ViewCompat;
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.help.HelpContent;
import br.com.gameloop.estoquesimples.help.HelpLoader;
import br.com.gameloop.estoquesimples.help.HelpSearch;
import br.com.gameloop.estoquesimples.help.HelpSpans;

/**
 * Central de ajuda: perguntas frequentes com busca, lidas de um arquivo que
 * viaja com o aplicativo (abre sem internet). É a primeira parada do menu
 * "Ajuda e suporte"; o suporte continua a um toque, no cartão do fim da
 * lista.
 *
 * Sem busca, a lista vem agrupada por categoria (chips no topo filtram);
 * com busca, vira uma lista só, ordenada por relevância, com a categoria
 * escrita em cada resultado. As regras de conteúdo e de busca são as mesmas
 * da web: ver {@link HelpContent} e {@link HelpSearch}.
 */
public class HelpActivity extends BaseActivity {

    /** Id de um artigo para abrir a tela já nele (rolada e com a resposta aberta). */
    private static final String EXTRA_ARTICLE_ID = "br.com.gameloop.estoquesimples.HELP_ARTICLE";

    private static final String STATE_QUERY = "query";
    private static final String STATE_CATEGORY = "category";
    private static final String STATE_EXPANDED = "expanded";
    private static final String STATE_SEARCH_REPORTED = "searchReported";

    /** A busca conta uma vez, depois que a pessoa para de digitar. */
    private static final long SEARCH_EVENT_DELAY_MS = 1000;
    private static final long CHEVRON_MS = 180;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private HelpContent content;
    private EditText searchField;
    private View clearSearch;
    private HorizontalScrollView chipScroll;
    private LinearLayout chipRow;
    private TextView resultCount;
    private ListView listView;
    private View emptyView;
    private TextView emptyTitle;
    private TextView emptyMessage;
    private RowAdapter adapter;

    private final List<Row> rows = new ArrayList<>();
    private final List<TextView> chips = new ArrayList<>();
    /** Respostas já montadas (negrito, listas): rolar a lista não refaz o texto. */
    private final Map<String, CharSequence> answers = new HashMap<>();
    /** Ids dos artigos com a resposta aberta. Sobrevive à rotação. */
    private final Set<String> expanded = new LinkedHashSet<>();

    private String query = "";
    /** {@code null} = "Todas". */
    private String selectedCategory;
    private int resultados;
    private Runnable pendingSearchEvent;
    /** Última busca já contada, para a rotação da tela não contar de novo. */
    private String searchReported;

    public static void open(Context context) {
        open(context, null);
    }

    /** Abre a ajuda no artigo indicado; id desconhecido abre a tela normal. */
    public static void open(Context context, String articleId) {
        context.startActivity(intent(context, articleId));
    }

    static Intent intent(Context context, String articleId) {
        Intent intent = new Intent(context, HelpActivity.class);
        if (articleId != null) {
            intent.putExtra(EXTRA_ARTICLE_ID, articleId);
        }
        return intent;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_help);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Central de ajuda");
        }

        searchField = findViewById(R.id.searchField);
        clearSearch = findViewById(R.id.clearSearch);
        chipScroll = findViewById(R.id.chipScroll);
        chipRow = findViewById(R.id.chipRow);
        resultCount = findViewById(R.id.resultCount);
        listView = findViewById(R.id.helpList);

        // O cartão de suporte é o rodapé da lista: aparece sempre, depois da
        // última pergunta, inclusive quando a busca não acha nada.
        View footer = LayoutInflater.from(this).inflate(R.layout.item_help_footer, listView, false);
        emptyView = footer.findViewById(R.id.helpEmpty);
        emptyTitle = footer.findViewById(R.id.helpEmptyTitle);
        emptyMessage = footer.findViewById(R.id.helpEmptyMessage);
        footer.findViewById(R.id.helpContactButton).setOnClickListener(v ->
                startActivity(new Intent(this, SupportNewActivity.class)));
        // CLEAR_TOP + SINGLE_TOP: quem veio da tela de solicitações volta para
        // aquela mesma tela em vez de empilhar ajuda → suporte → ajuda…
        footer.findViewById(R.id.helpTicketsButton).setOnClickListener(v ->
                startActivity(new Intent(this, SupportActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)));
        listView.addFooterView(footer, null, false);

        adapter = new RowAdapter();
        listView.setAdapter(adapter);

        content = HelpLoader.load(this);
        if (content == null) {
            mostrarFalha();
            return;
        }

        if (savedInstanceState != null) {
            query = texto(savedInstanceState.getString(STATE_QUERY));
            selectedCategory = savedInstanceState.getString(STATE_CATEGORY);
            searchReported = savedInstanceState.getString(STATE_SEARCH_REPORTED);
            ArrayList<String> abertos = savedInstanceState.getStringArrayList(STATE_EXPANDED);
            if (abertos != null) {
                expanded.addAll(abertos);
            }
        }
        if (selectedCategory != null && content.category(selectedCategory) == null) {
            selectedCategory = null;
        }

        montarChips();
        prepararBusca();

        String articleId = savedInstanceState == null ? getIntent().getStringExtra(EXTRA_ARTICLE_ID) : null;
        HelpContent.Article destino = articleId == null ? null : content.article(articleId);
        if (destino != null) {
            expanded.add(destino.id);
        }
        atualizarLista();
        if (destino != null) {
            listView.setSelection(posicaoDe(destino.id));
            Analytics.track(this, "help.article_opened", Analytics.props("article", destino.id));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_QUERY, query);
        outState.putString(STATE_CATEGORY, selectedCategory);
        outState.putString(STATE_SEARCH_REPORTED, searchReported);
        outState.putStringArrayList(STATE_EXPANDED, new ArrayList<>(expanded));
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Saiu da tela (para o suporte, por exemplo) antes do prazo: a busca
        // que estava na tela conta agora, senão se perderia justamente a
        // que não achou nada.
        enviarBuscaPendente();
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private static String texto(String valor) {
        return valor == null ? "" : valor;
    }

    // ------------------------------------------------------------------ topo

    private void montarChips() {
        LayoutInflater inflater = LayoutInflater.from(this);
        adicionarChip(inflater, null, "Todas");
        for (HelpContent.Category category : content.categories) {
            adicionarChip(inflater, category.id, category.title);
        }
    }

    private void adicionarChip(LayoutInflater inflater, String categoryId, String titulo) {
        TextView chip = (TextView) inflater.inflate(R.layout.item_help_chip, chipRow, false);
        chip.setText(titulo);
        chip.setTag(categoryId);
        chip.setOnClickListener(v -> selecionarCategoria(categoryId));
        chipRow.addView(chip);
        chips.add(chip);
    }

    private void selecionarCategoria(String categoryId) {
        if (categoryId == null ? selectedCategory == null : categoryId.equals(selectedCategory)) {
            return;
        }
        selectedCategory = categoryId;
        atualizarLista();
        listView.setSelection(0);
    }

    private void prepararBusca() {
        // O texto restaurado entra antes do listener: não é a pessoa digitando.
        searchField.setText(query);
        clearSearch.setVisibility(query.isEmpty() ? View.GONE : View.VISIBLE);

        searchField.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                String novo = s.toString();
                if (novo.equals(query)) {
                    return;
                }
                query = novo;
                clearSearch.setVisibility(query.isEmpty() ? View.GONE : View.VISIBLE);
                atualizarLista();
                listView.setSelection(0);
                agendarEventoDeBusca();
            }
        });
        searchField.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                esconderTeclado();
                return true;
            }
            return false;
        });
        clearSearch.setOnClickListener(v -> {
            searchField.setText("");
            esconderTeclado();
        });
        // Rolar os resultados recolhe o teclado, que cobre metade da lista.
        listView.setOnScrollListener(new AbsListView.OnScrollListener() {
            @Override
            public void onScrollStateChanged(AbsListView view, int scrollState) {
                if (scrollState == SCROLL_STATE_TOUCH_SCROLL && searchField.hasFocus()) {
                    esconderTeclado();
                }
            }

            @Override
            public void onScroll(AbsListView view, int first, int visible, int total) {
            }
        });
    }

    private void esconderTeclado() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(searchField.getWindowToken(), 0);
        }
        searchField.clearFocus();
    }

    // ----------------------------------------------------------------- lista

    private void atualizarLista() {
        boolean buscando = HelpSearch.isSearch(query);
        rows.clear();

        if (buscando) {
            List<HelpContent.Article> encontrados = HelpSearch.search(content.articles, query);
            resultados = encontrados.size();
            for (HelpContent.Article article : encontrados) {
                rows.add(Row.article(article, content.category(article.category)));
            }
            resultCount.setText(Texto.plural(resultados, "resultado", "resultados"));
        } else {
            resultados = 0;
            for (HelpContent.Category category : content.categories) {
                if (selectedCategory != null && !selectedCategory.equals(category.id)) {
                    continue;
                }
                rows.add(Row.header(category));
                for (HelpContent.Article article : content.articlesOf(category.id)) {
                    rows.add(Row.article(article, null));
                }
            }
        }

        boolean vazio = buscando && resultados == 0;
        if (vazio) {
            emptyTitle.setText("Nada encontrado para “" + query.trim() + "”");
            emptyMessage.setText("Tente outras palavras, ou fale com o suporte: a gente responde por aqui.");
        }
        emptyView.setVisibility(vazio ? View.VISIBLE : View.GONE);
        // Sem resultado, a frase acima já diz tudo; "0 resultados" seria ruído.
        resultCount.setVisibility(buscando && !vazio ? View.VISIBLE : View.GONE);
        chipScroll.setVisibility(buscando ? View.GONE : View.VISIBLE);
        for (TextView chip : chips) {
            Object id = chip.getTag();
            chip.setSelected(id == null ? selectedCategory == null : id.equals(selectedCategory));
        }
        adapter.notifyDataSetChanged();
    }

    /** Arquivo ausente ou corrompido: sem busca nem chips, só o caminho do suporte. */
    private void mostrarFalha() {
        findViewById(R.id.searchBar).setVisibility(View.GONE);
        chipScroll.setVisibility(View.GONE);
        emptyTitle.setText("Não foi possível abrir a ajuda");
        emptyMessage.setText("As perguntas frequentes não carregaram neste aparelho. Fale com o suporte: a gente responde por aqui.");
        emptyView.setVisibility(View.VISIBLE);
    }

    private int posicaoDe(String articleId) {
        for (int i = 0; i < rows.size(); i++) {
            Row row = rows.get(i);
            if (row.article != null && row.article.id.equals(articleId)) {
                return i;
            }
        }
        return 0;
    }

    private CharSequence respostaDe(HelpContent.Article article) {
        CharSequence pronta = answers.get(article.id);
        if (pronta == null) {
            pronta = HelpSpans.render(this, article.answer);
            answers.put(article.id, pronta);
        }
        return pronta;
    }

    /** Abre ou fecha só o artigo tocado; os outros ficam como estão. */
    private void alternar(HelpContent.Article article, ArticleHolder holder) {
        boolean abrir = !expanded.contains(article.id);
        if (abrir) {
            expanded.add(article.id);
            // Se havia uma busca esperando o prazo, ela conta antes: no
            // painel, "buscou" precisa vir antes de "abriu o artigo".
            enviarBuscaPendente();
            Analytics.track(this, "help.article_opened", Analytics.props("article", article.id));
        } else {
            expanded.remove(article.id);
        }
        // Mexe direto na linha tocada, sem notifyDataSetChanged: a lista só
        // refaz a medida dela e a animação da seta não é interrompida.
        holder.aplicarEstado(abrir, true);
        if (abrir) {
            manterVisivel(holder.root);
        }
    }

    /** Resposta aberta no pé da tela: rola o bastante para ela aparecer, sem tirar a pergunta do topo. */
    private void manterVisivel(View linha) {
        listView.post(() -> {
            if (linha.getParent() != listView) {
                return;
            }
            int limite = listView.getHeight() - listView.getPaddingBottom();
            int sobra = linha.getBottom() - limite;
            int folga = linha.getTop() - listView.getPaddingTop();
            if (sobra > 0 && folga > 0) {
                listView.smoothScrollBy(Math.min(sobra, folga), 250);
            }
        });
    }

    // ------------------------------------------------------------- analytics

    /**
     * Uma busca conta uma vez, um segundo depois da última tecla, só com a
     * quantidade de resultados. O texto digitado nunca vai no evento: pode
     * ter nome de cliente, de produto, qualquer coisa.
     */
    private void agendarEventoDeBusca() {
        if (pendingSearchEvent != null) {
            handler.removeCallbacks(pendingSearchEvent);
            pendingSearchEvent = null;
        }
        if (!HelpSearch.isSearch(query)) {
            searchReported = null;
            return;
        }
        pendingSearchEvent = this::enviarBuscaPendente;
        handler.postDelayed(pendingSearchEvent, SEARCH_EVENT_DELAY_MS);
    }

    private void enviarBuscaPendente() {
        if (pendingSearchEvent == null) {
            return;
        }
        handler.removeCallbacks(pendingSearchEvent);
        pendingSearchEvent = null;
        String termos = HelpSearch.terms(query).toString();
        if (termos.equals(searchReported)) {
            return;
        }
        searchReported = termos;
        Analytics.track(this, "help.searched", Analytics.props("results", resultados));
    }

    // ---------------------------------------------------------------- linhas

    private static final class Row {
        static final int TYPE_HEADER = 0;
        static final int TYPE_ARTICLE = 1;

        final HelpContent.Category header;
        final HelpContent.Article article;
        /** Só na busca: a categoria escrita acima da pergunta. */
        final HelpContent.Category label;

        private Row(HelpContent.Category header, HelpContent.Article article, HelpContent.Category label) {
            this.header = header;
            this.article = article;
            this.label = label;
        }

        static Row header(HelpContent.Category category) {
            return new Row(category, null, null);
        }

        static Row article(HelpContent.Article article, HelpContent.Category label) {
            return new Row(null, article, label);
        }
    }

    private final class ArticleHolder {
        final View root;
        final View header;
        final TextView category;
        final TextView question;
        final ImageView chevron;
        final View divider;
        final TextView answer;
        HelpContent.Article article;

        ArticleHolder(View root) {
            this.root = root;
            header = root.findViewById(R.id.articleHeader);
            category = root.findViewById(R.id.articleCategory);
            question = root.findViewById(R.id.articleQuestion);
            chevron = root.findViewById(R.id.articleChevron);
            divider = root.findViewById(R.id.articleDivider);
            answer = root.findViewById(R.id.articleAnswer);
            // O efeito de toque da linha da pergunta respeita os cantos
            // arredondados do cartão. Em código porque o atributo XML só
            // existe a partir da API 31.
            root.setClipToOutline(true);
            header.setOnClickListener(v -> {
                if (article != null) {
                    alternar(article, this);
                }
            });
        }

        void bind(Row row) {
            article = row.article;
            question.setText(article.question);
            if (row.label != null) {
                category.setText(row.label.title);
                category.setVisibility(View.VISIBLE);
            } else {
                category.setVisibility(View.GONE);
            }
            aplicarEstado(expanded.contains(article.id), false);
        }

        void aplicarEstado(boolean aberto, boolean animar) {
            if (aberto) {
                answer.setText(respostaDe(article));
            }
            answer.setVisibility(aberto ? View.VISIBLE : View.GONE);
            divider.setVisibility(aberto ? View.VISIBLE : View.GONE);

            float rotacao = aberto ? 180f : 0f;
            chevron.animate().cancel();
            if (animar) {
                chevron.animate().rotation(rotacao).setDuration(CHEVRON_MS).start();
            } else {
                chevron.setRotation(rotacao);
            }

            // Leitor de tela: "Expandido"/"Recolhido" junto da pergunta e
            // "toque duas vezes para ver a resposta" no lugar do genérico "ativar".
            ViewCompat.setStateDescription(header, aberto ? "Expandido" : "Recolhido");
            ViewCompat.replaceAccessibilityAction(header,
                    AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK,
                    aberto ? "recolher a resposta" : "ver a resposta", null);
        }
    }

    private final class RowAdapter extends BaseAdapter {

        @Override
        public int getCount() {
            return rows.size();
        }

        @Override
        public Row getItem(int position) {
            return rows.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public int getViewTypeCount() {
            return 2;
        }

        @Override
        public int getItemViewType(int position) {
            return rows.get(position).article != null ? Row.TYPE_ARTICLE : Row.TYPE_HEADER;
        }

        // O toque é da linha da pergunta, dentro do cartão; a lista em si
        // não tem OnItemClickListener nem seletor visível.
        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Row row = rows.get(position);
            if (row.article == null) {
                View view = convertView != null
                        ? convertView
                        : LayoutInflater.from(HelpActivity.this).inflate(R.layout.item_help_header, parent, false);
                TextView title = view.findViewById(R.id.categoryTitle);
                TextView summary = view.findViewById(R.id.categorySummary);
                title.setText(row.header.title);
                ViewCompat.setAccessibilityHeading(title, true);
                summary.setText(row.header.summary);
                summary.setVisibility(row.header.summary.isEmpty() ? View.GONE : View.VISIBLE);
                return view;
            }

            ArticleHolder holder;
            if (convertView != null) {
                holder = (ArticleHolder) convertView.getTag();
            } else {
                View view = LayoutInflater.from(HelpActivity.this).inflate(R.layout.item_help_article, parent, false);
                holder = new ArticleHolder(view);
                view.setTag(holder);
            }
            holder.bind(row);
            return holder.root;
        }
    }
}
