package br.com.gameloop.estoquesimples.help;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Busca e formato de texto da Central de ajuda. Os casos de busca são os
 * mesmos que valem para a web ({@code packages/help/index.ts}).
 */
public class HelpSearchTest {

    private static HelpContent.Article artigo(String id, String pergunta, String resposta, String... palavrasChave) {
        return new HelpContent.Article(id, "geral", pergunta,
                Collections.singletonList(resposta), Arrays.asList(palavrasChave), null);
    }

    private static List<String> ids(List<HelpContent.Article> artigos) {
        List<String> ids = new ArrayList<>();
        for (HelpContent.Article artigo : artigos) {
            ids.add(artigo.id);
        }
        return ids;
    }

    private static final List<HelpContent.Article> ARTIGOS = Arrays.asList(
            artigo("sincroniza", "Como funciona a sincronização?",
                    "O aplicativo guarda tudo no celular e envia para a nuvem.", "sync", "backup"),
            artigo("senha", "Esqueci minha senha",
                    "Use **Esqueci minha senha** na tela de entrada.", "recuperar", "login"),
            artigo("reembolso", "Posso pedir reembolso?",
                    "Em até 7 dias depois da contratação. A sincronização continua.", "estorno", "dinheiro de volta"),
            artigo("cancelar", "Como cancelo a assinatura?",
                    "Cancele no mesmo lugar em que assinou.", "sincronizacao pausada", "senha"));

    // ---------------------------------------------------------- normalização

    @Test
    public void foldRemovesAccentsAndCase() {
        assertEquals("sincronizacao", HelpSearch.fold("Sincronização"));
        assertEquals("nao e so acucar", HelpSearch.fold("NÃO é só AÇÚCAR"));
        assertEquals("", HelpSearch.fold(null));
    }

    @Test
    public void termsSplitOnPunctuationAndDropSingleLetters() {
        assertEquals(Arrays.asList("mail", "senha"), HelpSearch.terms("  E-mail, a SENHA? "));
        assertTrue(HelpSearch.terms("a e o ?").isEmpty());
        assertFalse(HelpSearch.isSearch(" a "));
        assertTrue(HelpSearch.isSearch("pix"));
    }

    @Test
    public void termsDropFinalSOnlyFromLongWords() {
        // Mais de 4 letras e termina em "s": sai o "s".
        assertEquals(Collections.singletonList("reembolso"), HelpSearch.terms("reembolsos"));
        assertEquals(Collections.singletonList("dado"), HelpSearch.terms("dados"));
        // Até 4 letras fica como está ("mais", "pix", "meus").
        assertEquals(Arrays.asList("mais", "meus"), HelpSearch.terms("mais meus"));
        // Só um "s" sai, e só do fim.
        assertEquals(Collections.singletonList("acesso"), HelpSearch.terms("acessos"));
        assertEquals(Collections.singletonList("senha"), HelpSearch.terms("senha"));
    }

    // ----------------------------------------------------------------- busca

    @Test
    public void searchIgnoresAccentsAndCase() {
        assertEquals("sincroniza", HelpSearch.search(ARTIGOS, "SINCRONIZACAO").get(0).id);
        assertEquals("sincroniza", HelpSearch.search(ARTIGOS, "sincronização").get(0).id);
    }

    @Test
    public void questionBeatsKeywordsBeatsAnswer() {
        // "sincronizacao": pergunta (5) > palavra-chave (3) > resposta (1).
        assertEquals(Arrays.asList("sincroniza", "cancelar", "reembolso"),
                ids(HelpSearch.search(ARTIGOS, "sincronizacao")));
    }

    @Test
    public void tieKeepsFileOrder() {
        List<HelpContent.Article> iguais = Arrays.asList(
                artigo("b", "Plano Equipe", "x"),
                artigo("a", "Plano gratuito", "x"),
                artigo("c", "Sem relação", "fala do plano no texto"));
        assertEquals(Arrays.asList("b", "a", "c"), ids(HelpSearch.search(iguais, "plano")));
    }

    @Test
    public void everyWordMustMatchSomewhere() {
        // "senha" está na pergunta de um e na palavra-chave de outro;
        // "entrada" só existe na resposta do primeiro.
        assertEquals(Arrays.asList("senha", "cancelar"), ids(HelpSearch.search(ARTIGOS, "senha")));
        assertEquals(Collections.singletonList("senha"), ids(HelpSearch.search(ARTIGOS, "senha entrada")));
        assertTrue(HelpSearch.search(ARTIGOS, "senha boleto").isEmpty());
    }

    @Test
    public void scoreAddsUpAcrossWords() {
        List<HelpContent.Article> artigos = Arrays.asList(
                artigo("um", "Pagamento", "por boleto", "pix"),          // 5 + 1 = 6
                artigo("dois", "Pagamento por boleto", "na web"),         // 5 + 5 = 10
                artigo("tres", "Cobrança", "x", "pagamento", "boleto"));  // 3 + 3 = 6
        assertEquals(Arrays.asList("dois", "um", "tres"), ids(HelpSearch.search(artigos, "pagamento boleto")));
    }

    @Test
    public void pluralFindsSingularAndSingularFindsPlural() {
        assertEquals(Collections.singletonList("reembolso"), ids(HelpSearch.search(ARTIGOS, "reembolsos")));
        List<HelpContent.Article> plural = Collections.singletonList(
                artigo("relatorios", "Quais relatórios existem?", "x"));
        assertEquals(1, HelpSearch.search(plural, "relatorio").size());
        assertEquals(1, HelpSearch.search(plural, "relatórios").size());
    }

    @Test
    public void partialWordMatchesWhileTyping() {
        assertEquals("sincroniza", HelpSearch.search(ARTIGOS, "sincroniz").get(0).id);
    }

    @Test
    public void boldMarkersDoNotBreakTheSearch() {
        assertEquals("senha", HelpSearch.search(ARTIGOS, "esqueci minha senha tela").get(0).id);
    }

    @Test
    public void queryWithoutTermsReturnsTheSameList() {
        assertSame(ARTIGOS, HelpSearch.search(ARTIGOS, "  a ? "));
        assertSame(ARTIGOS, HelpSearch.search(ARTIGOS, ""));
        assertSame(ARTIGOS, HelpSearch.search(ARTIGOS, null));
    }

    // -------------------------------------------------------------- conteúdo

    @Test
    public void contentHidesOtherPlatformsAndEmptyCategories() {
        List<HelpContent.Category> categorias = Arrays.asList(
                new HelpContent.Category("geral", "Geral", "resumo"),
                new HelpContent.Category("web", "Só web", ""));
        List<HelpContent.Article> artigos = Arrays.asList(
                new HelpContent.Article("todos", "geral", "P1", Collections.singletonList("r"), null, null),
                new HelpContent.Article("android", "geral", "P2", Collections.singletonList("r"), null,
                        Collections.singletonList("android")),
                new HelpContent.Article("ambos", "geral", "P3", Collections.singletonList("r"), null,
                        Arrays.asList("web", "android")),
                new HelpContent.Article("so-web", "web", "P4", Collections.singletonList("r"), null,
                        Collections.singletonList("web")),
                new HelpContent.Article("nenhuma", "geral", "P5", Collections.singletonList("r"), null,
                        Collections.<String>emptyList()),
                new HelpContent.Article("orfao", "sumiu", "P6", Collections.singletonList("r"), null, null));

        HelpContent content = new HelpContent(categorias, artigos);

        assertEquals(Arrays.asList("todos", "android", "ambos"), ids(content.articles));
        assertEquals(1, content.categories.size());
        assertEquals("geral", content.categories.get(0).id);
        assertEquals(3, content.articlesOf("geral").size());
        assertNull(content.article("so-web"));
        assertNull(content.category("web"));
        assertEquals("P2", content.article("android").question);
    }

    // --------------------------------------------------------------- formato

    @Test
    public void boldMarkersAreRemovedAndRangesPointAtTheText() {
        HelpMarkup.Block bloco = HelpMarkup.parse("Toque em **Novo**, depois em **Salvar**.");
        assertFalse(bloco.bullet);
        assertEquals("Toque em Novo, depois em Salvar.", bloco.text);
        assertArrayEquals(new int[] {9, 13, 25, 31}, bloco.bold);
        assertEquals("Novo", bloco.text.substring(bloco.bold[0], bloco.bold[1]));
        assertEquals("Salvar", bloco.text.substring(bloco.bold[2], bloco.bold[3]));
    }

    @Test
    public void bulletPrefixIsStripped() {
        HelpMarkup.Block bloco = HelpMarkup.parse("• **Suspender:** ela continua na lista.");
        assertTrue(bloco.bullet);
        assertEquals("Suspender: ela continua na lista.", bloco.text);
        assertArrayEquals(new int[] {0, 10}, bloco.bold);
    }

    @Test
    public void plainTextAndWholeBoldBlock() {
        HelpMarkup.Block simples = HelpMarkup.parse("Criar a conta é grátis.");
        assertEquals("Criar a conta é grátis.", simples.text);
        assertEquals(0, simples.bold.length);

        HelpMarkup.Block inteiro = HelpMarkup.parse("**Nada é apagado**");
        assertEquals("Nada é apagado", inteiro.text);
        assertArrayEquals(new int[] {0, 14}, inteiro.bold);
    }

    @Test
    public void unbalancedAsterisksStayAsText() {
        HelpMarkup.Block bloco = HelpMarkup.parse("2 * 3 = 6 e **sem fechar");
        assertEquals("2 * 3 = 6 e **sem fechar", bloco.text);
        assertEquals(0, bloco.bold.length);
        // Marcador no meio da frase não vira item de lista.
        assertFalse(HelpMarkup.parse("Itens: • um").bullet);
    }

    @Test
    public void answerKeepsBlockOrder() {
        List<HelpMarkup.Block> blocos = HelpMarkup.parse(Arrays.asList(
                "Há dois caminhos:", "• **Suspender:** fica na lista.", "• **Remover:** sai.", "Pronto."));
        assertEquals(4, blocos.size());
        assertFalse(blocos.get(0).bullet);
        assertTrue(blocos.get(1).bullet);
        assertTrue(blocos.get(2).bullet);
        assertFalse(blocos.get(3).bullet);
        assertEquals("Remover: sai.", blocos.get(2).text);
    }
}
