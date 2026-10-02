package br.com.gameloop.estoquesimples.help;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Busca da Central de ajuda. É a mesma regra de {@code searchArticles} em
 * {@code packages/help/index.ts} (web e painel): mudou lá, mude aqui — o
 * teste {@code HelpSearchTest} trava os casos que precisam bater.
 */
public final class HelpSearch {

    // Pesos por palavra: achar na pergunta vale mais do que nas
    // palavras-chave, que valem mais do que só no texto da resposta.
    private static final int PESO_PERGUNTA = 5;
    private static final int PESO_PALAVRA_CHAVE = 3;
    private static final int PESO_RESPOSTA = 1;

    private HelpSearch() {
    }

    /** Sem acento e sem caixa: "Sincronização" é achada por "sincronizacao". */
    public static String fold(String text) {
        if (text == null) {
            return "";
        }
        // Decompõe ("ã" vira "a" + til) e descarta as marcas. O laço faz o
        // mesmo que replaceAll("\\p{M}+", ""), sem compilar uma expressão
        // regular a cada texto.
        String decomposto = Normalizer.normalize(text, Normalizer.Form.NFD);
        StringBuilder sb = new StringBuilder(decomposto.length());
        for (int i = 0; i < decomposto.length(); ) {
            int ponto = decomposto.codePointAt(i);
            i += Character.charCount(ponto);
            int tipo = Character.getType(ponto);
            if (tipo != Character.NON_SPACING_MARK
                    && tipo != Character.COMBINING_SPACING_MARK
                    && tipo != Character.ENCLOSING_MARK) {
                sb.appendCodePoint(ponto);
            }
        }
        return sb.toString().toLowerCase(Locale.ROOT);
    }

    /**
     * Palavras da busca, já normalizadas. Termos de uma letra só atrapalham
     * ("a", "e", "o" estão em todo texto). O "s" final de palavras longas
     * sai ("reembolsos" acha "reembolso"): a comparação é por trecho, então
     * o singular também encontra o plural.
     */
    public static List<String> terms(String query) {
        List<String> termos = new ArrayList<>();
        for (String termo : fold(query).split("[^a-z0-9]+")) {
            if (termo.length() < 2) {
                continue;
            }
            if (termo.length() > 4 && termo.endsWith("s")) {
                termo = termo.substring(0, termo.length() - 1);
            }
            termos.add(termo);
        }
        return termos;
    }

    /** Há o que buscar? Com só letras soltas ou pontuação, a tela segue na lista por categoria. */
    public static boolean isSearch(String query) {
        return !terms(query).isEmpty();
    }

    /**
     * Todas as palavras digitadas precisam aparecer (na pergunta, nas
     * palavras-chave ou na resposta); faltou uma, o artigo sai. Quem soma
     * mais pontos vem primeiro e, no empate, vale a ordem do arquivo.
     * Sem nenhum termo válido, devolve a lista como veio.
     */
    public static List<HelpContent.Article> search(List<HelpContent.Article> articles, String query) {
        List<String> termos = terms(query);
        if (termos.isEmpty()) {
            return articles;
        }

        List<Pontuado> pontuados = new ArrayList<>();
        for (int ordem = 0; ordem < articles.size(); ordem++) {
            HelpContent.Article article = articles.get(ordem);
            int pontos = pontuar(article, termos);
            if (pontos > 0) {
                pontuados.add(new Pontuado(article, pontos, ordem));
            }
        }
        Collections.sort(pontuados, new Comparator<Pontuado>() {
            @Override
            public int compare(Pontuado a, Pontuado b) {
                return a.pontos != b.pontos
                        ? Integer.compare(b.pontos, a.pontos)
                        : Integer.compare(a.ordem, b.ordem);
            }
        });

        List<HelpContent.Article> resultado = new ArrayList<>(pontuados.size());
        for (Pontuado item : pontuados) {
            resultado.add(item.article);
        }
        return resultado;
    }

    /** Soma dos pesos; 0 quando alguma palavra não aparece em lugar nenhum. */
    private static int pontuar(HelpContent.Article article, List<String> termos) {
        int pontos = 0;
        for (String termo : termos) {
            if (article.foldedQuestion().contains(termo)) {
                pontos += PESO_PERGUNTA;
            } else if (article.foldedKeywords().contains(termo)) {
                pontos += PESO_PALAVRA_CHAVE;
            } else if (article.foldedBody().contains(termo)) {
                pontos += PESO_RESPOSTA;
            } else {
                return 0;
            }
        }
        return pontos;
    }

    private static final class Pontuado {
        final HelpContent.Article article;
        final int pontos;
        final int ordem;

        Pontuado(HelpContent.Article article, int pontos, int ordem) {
            this.article = article;
            this.pontos = pontos;
            this.ordem = ordem;
        }
    }
}
