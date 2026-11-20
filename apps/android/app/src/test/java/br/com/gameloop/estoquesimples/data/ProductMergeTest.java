package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * O que uma importação pode e não pode mudar num produto que já existe.
 *
 * O caso que dá nome a este arquivo é o primeiro: até a versão 33, importar
 * uma lista de preços de duas colunas zerava quantidade, valor e estoque
 * mínimo e apagava categoria, SKU, código de barras, fornecedor, localização
 * e unidade de todo produto que ela casava.
 */
public class ProductMergeTest {

    private static ProductMerge.Atual cadastroCompleto() {
        ProductMerge.Atual atual = new ProductMerge.Atual();
        atual.nome = "Café em grãos";
        atual.descricao = "Pacote 1 kg";
        atual.quantidade = "40";
        atual.valor = "38.90";
        atual.custo = "25";
        atual.categoria = "Bebidas";
        atual.sku = "CAF-001";
        atual.codigoBarras = "7891234567890";
        atual.fornecedor = "Torrefação Central";
        atual.localizacao = "Prateleira A3";
        atual.estoqueMinimo = "10";
        atual.unidade = "kg";
        return atual;
    }

    /** Planilha "Descrição;Preço": só esses dois campos podem ser tocados. */
    @Test
    public void listaDePrecosNaoApagaORestoDoCadastro() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.nome = "Café em grãos";
        entrada.descricao = "Pacote 1 kg";
        entrada.valor = 42.50;
        entrada.informa(ProductMerge.Campo.NOME)
                .informa(ProductMerge.Campo.DESCRICAO)
                .informa(ProductMerge.Campo.VALOR);

        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);

        assertEquals(1, r.colunas.size());
        assertEquals("42.5", r.colunas.get("value"));
        assertFalse("quantidade não pode virar zero", r.quantidadeMudou);
        for (String coluna : new String[]{"sku", "barcode", "category", "supplier", "location",
                "unit", "min_stock", "cost", "amount"}) {
            assertFalse("não deve tocar " + coluna, r.colunas.containsKey(coluna));
        }
    }

    @Test
    public void colunaVaziaNaPlanilhaNaoApaga() {
        // Como a planilha marca presença só quando a célula tem conteúdo, uma
        // coluna "fornecedor" em branco não chega marcada — e não apaga.
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.fornecedor = "";
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertTrue(r.semMudanca());
    }

    /** Backup JSON: a chave existe com texto vazio, então apagar é a intenção. */
    @Test
    public void campoInformadoVazioApaga() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.fornecedor = "";
        entrada.informa(ProductMerge.Campo.FORNECEDOR);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertEquals("", r.colunas.get("supplier"));
    }

    @Test
    public void quantidadeDiferenteViraAjuste() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.quantidade = 55d;
        entrada.informa(ProductMerge.Campo.QUANTIDADE);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertTrue(r.quantidadeMudou);
        assertEquals(55d, r.quantidade, 0.0001);
        assertFalse("quantidade nunca é UPDATE: é movimentação",
                r.colunas.containsKey("amount"));
    }

    @Test
    public void quantidadeIgualNaoGeraMovimentacao() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.quantidade = 40d;
        entrada.informa(ProductMerge.Campo.QUANTIDADE);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertFalse(r.quantidadeMudou);
        assertTrue(r.semMudanca());
    }

    /** Backup com histórico: as movimentações do arquivo explicam o saldo. */
    @Test
    public void comHistoricoNoArquivoNaoLancaAjuste() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.quantidade = 55d;
        entrada.informa(ProductMerge.Campo.QUANTIDADE);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, true);
        assertFalse(r.quantidadeMudou);
    }

    @Test
    public void custoAusenteNaoApagaCustoCadastrado() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.custo = null;
        entrada.informa(ProductMerge.Campo.CUSTO);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertFalse(r.colunas.containsKey("cost"));
    }

    /** "38.90" no banco e 38.9 no arquivo é o mesmo preço. */
    @Test
    public void mesmoNumeroEmOutroFormatoNaoContaComoMudanca() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.valor = 38.9;
        entrada.estoqueMinimo = 10d;
        entrada.informa(ProductMerge.Campo.VALOR).informa(ProductMerge.Campo.ESTOQUE_MINIMO);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertTrue(r.semMudanca());
    }

    @Test
    public void produtoSemCustoRecebeOCustoDaPlanilha() {
        ProductMerge.Atual atual = cadastroCompleto();
        atual.custo = null;
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.custo = 19.9;
        entrada.informa(ProductMerge.Campo.CUSTO);
        ProductMerge.Resultado r = ProductMerge.merge(atual, entrada, false);
        assertEquals("19.9", r.colunas.get("cost"));
    }

    @Test
    public void linhaQueNadaInformaNaoMudaNada() {
        ProductMerge.Resultado r = ProductMerge.merge(
                cadastroCompleto(), new ProductMerge.Entrada(), false);
        assertTrue(r.semMudanca());
        assertTrue(r.colunas.isEmpty());
    }

    @Test
    public void textoEhComparadoSemEspacoSobrando() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.categoria = "  Bebidas  ";
        entrada.informa(ProductMerge.Campo.CATEGORIA);
        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);
        assertTrue(r.semMudanca());
    }

    @Test
    public void planilhaCompletaAtualizaOQueMudou() {
        ProductMerge.Entrada entrada = new ProductMerge.Entrada();
        entrada.nome = "Café em grãos";
        entrada.categoria = "Café";
        entrada.sku = "CAF-001";
        entrada.quantidade = 12d;
        entrada.informa(ProductMerge.Campo.NOME)
                .informa(ProductMerge.Campo.CATEGORIA)
                .informa(ProductMerge.Campo.SKU)
                .informa(ProductMerge.Campo.QUANTIDADE);

        ProductMerge.Resultado r = ProductMerge.merge(cadastroCompleto(), entrada, false);

        assertEquals("Café", r.colunas.get("category"));
        assertFalse(r.colunas.containsKey("sku"));
        assertFalse(r.colunas.containsKey("name"));
        assertTrue(r.quantidadeMudou);
        assertEquals(12d, r.quantidade, 0.0001);
    }
}
