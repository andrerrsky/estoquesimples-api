package br.com.gameloop.estoquesimples.help;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Conteúdo da Central de ajuda já filtrado para o aplicativo.
 *
 * A fonte é {@code packages/help/faq.json} (raiz do monorepo), a mesma que a
 * web e o painel usam; o app lê a cópia em {@code assets/help/faq.json}
 * ({@link HelpLoader}). As regras daqui espelham {@code packages/help/index.ts}
 * para que a mesma pergunta apareça igual nos três lugares.
 *
 * Esta classe não toca em nada do Android de propósito: assim o filtro por
 * plataforma e a busca ({@link HelpSearch}) rodam em teste de JVM.
 */
public final class HelpContent {

    /** Como este aplicativo aparece em {@code platforms} do JSON. */
    public static final String PLATAFORMA = "android";

    public static final class Category {
        public final String id;
        public final String title;
        public final String summary;

        public Category(String id, String title, String summary) {
            this.id = id;
            this.title = title == null ? "" : title;
            this.summary = summary == null ? "" : summary;
        }
    }

    public static final class Article {
        public final String id;
        public final String category;
        public final String question;
        /** Blocos da resposta: parágrafo, ou item de lista quando começa com "• ". */
        public final List<String> answer;
        /** Só para a busca; nunca aparece na tela. */
        public final List<String> keywords;
        /** {@code null} = todas as plataformas. */
        public final List<String> platforms;

        // Texto sem acento e em minúsculas, para a busca. Normalizar custa
        // mais do que ler o arquivo, então é feito uma vez só e guardado (a
        // busca roda a cada tecla): ou adiantado por prepareSearch(), fora
        // da thread principal, ou na primeira busca, o que vier antes. Se
        // as duas threads calcularem o mesmo campo, o resultado é idêntico.
        private volatile String foldedQuestion;
        private volatile String foldedKeywords;
        private volatile String foldedBody;

        public Article(String id, String category, String question, List<String> answer,
                       List<String> keywords, List<String> platforms) {
            this.id = id;
            this.category = category;
            this.question = question == null ? "" : question;
            this.answer = answer == null
                    ? Collections.<String>emptyList()
                    : Collections.unmodifiableList(new ArrayList<>(answer));
            this.keywords = keywords == null
                    ? Collections.<String>emptyList()
                    : Collections.unmodifiableList(new ArrayList<>(keywords));
            this.platforms = platforms == null
                    ? null
                    : Collections.unmodifiableList(new ArrayList<>(platforms));
        }

        String foldedQuestion() {
            if (foldedQuestion == null) {
                foldedQuestion = HelpSearch.fold(question);
            }
            return foldedQuestion;
        }

        String foldedKeywords() {
            if (foldedKeywords == null) {
                foldedKeywords = HelpSearch.fold(join(keywords));
            }
            return foldedKeywords;
        }

        String foldedBody() {
            if (foldedBody == null) {
                foldedBody = HelpSearch.fold(join(answer));
            }
            return foldedBody;
        }

        /** Sem {@code platforms}, vale em todo lugar; com ela, só onde foi listada. */
        public boolean visibleOn(String platform) {
            return platforms == null || platforms.contains(platform);
        }

        private static String join(List<String> parts) {
            StringBuilder sb = new StringBuilder();
            for (String part : parts) {
                if (sb.length() > 0) {
                    sb.append(' ');
                }
                sb.append(part);
            }
            return sb.toString();
        }
    }

    public final List<Category> categories;
    public final List<Article> articles;

    /**
     * Fica só com o que o aplicativo mostra: artigos de outra plataforma e
     * artigos de categoria desconhecida saem, e categoria que ficou sem
     * artigo sai junto (não faz sentido um chip que abre uma lista vazia).
     */
    public HelpContent(List<Category> categories, List<Article> articles) {
        Set<String> conhecidas = new HashSet<>();
        for (Category category : categories) {
            conhecidas.add(category.id);
        }
        List<Article> visiveis = new ArrayList<>();
        Set<String> usadas = new HashSet<>();
        for (Article article : articles) {
            if (article.visibleOn(PLATAFORMA) && conhecidas.contains(article.category)) {
                visiveis.add(article);
                usadas.add(article.category);
            }
        }
        List<Category> comArtigos = new ArrayList<>();
        for (Category category : categories) {
            if (usadas.contains(category.id)) {
                comArtigos.add(category);
            }
        }
        this.categories = Collections.unmodifiableList(comArtigos);
        this.articles = Collections.unmodifiableList(visiveis);
    }

    /** Adianta a normalização do texto para a busca; pode rodar em qualquer thread. */
    public void prepareSearch() {
        for (Article article : articles) {
            article.foldedQuestion();
            article.foldedKeywords();
            article.foldedBody();
        }
    }

    public Category category(String id) {
        for (Category category : categories) {
            if (category.id.equals(id)) {
                return category;
            }
        }
        return null;
    }

    public Article article(String id) {
        for (Article article : articles) {
            if (article.id.equals(id)) {
                return article;
            }
        }
        return null;
    }

    /** Artigos de uma categoria, na ordem do arquivo. */
    public List<Article> articlesOf(String categoryId) {
        List<Article> lista = new ArrayList<>();
        for (Article article : articles) {
            if (article.category.equals(categoryId)) {
                lista.add(article);
            }
        }
        return lista;
    }
}
