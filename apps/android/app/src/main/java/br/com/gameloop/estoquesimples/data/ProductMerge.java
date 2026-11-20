package br.com.gameloop.estoquesimples.data;

import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Decide o que uma linha importada muda num produto que já existe.
 *
 * Existe por um defeito que destruía cadastro de cliente: a importação
 * gravava <b>todos</b> os campos da linha, e os campos que o arquivo não
 * trazia chegavam aqui como texto vazio ou zero. Uma lista de preços com duas
 * colunas ("Descrição;Preço"), que é o arquivo mais comum que o lojista tem à
 * mão, zerava quantidade, valor e estoque mínimo e apagava categoria, SKU,
 * código de barras, fornecedor, localização e unidade de todo produto que ela
 * casava — e, como apagar o SKU quebra o casamento, a importação seguinte
 * duplicava o produto. A quantidade zerada ainda nascia como movimentação de
 * ajuste, que é imutável.
 *
 * A regra agora é <b>escrita por presença</b>: só o campo que o arquivo
 * informou entra na gravação. Quem decide o que está presente é quem leu o
 * arquivo ({@link DataExchange.RowProduct}), porque "presente" depende do
 * formato — numa planilha é a coluna existir e a célula ter conteúdo; num
 * backup JSON é a chave existir, e aí o vazio apaga de propósito, senão
 * restaurar uma cópia não limparia o campo que o dono limpou.
 *
 * Classe pura (sem Android) para poder ser testada: o projeto não tem
 * Robolectric, então a decisão mora aqui e o {@link DataExchange} só aplica.
 */
public final class ProductMerge {

    private ProductMerge() {
    }

    /** Os campos de produto que uma importação pode tocar. */
    public enum Campo {
        NOME("name"),
        DESCRICAO("description"),
        QUANTIDADE("amount"),
        VALOR("value"),
        CUSTO("cost"),
        CATEGORIA("category"),
        SKU("sku"),
        CODIGO_BARRAS("barcode"),
        FORNECEDOR("supplier"),
        LOCALIZACAO("location"),
        ESTOQUE_MINIMO("min_stock"),
        UNIDADE("unit");

        /** Coluna correspondente na tabela de produtos. */
        public final String coluna;

        Campo(String coluna) {
            this.coluna = coluna;
        }
    }

    /** O produto como está hoje, com os valores de texto que o banco guarda. */
    public static final class Atual {
        public String nome;
        public String descricao;
        public String quantidade;
        public String valor;
        public String custo;
        public String categoria;
        public String sku;
        public String codigoBarras;
        public String fornecedor;
        public String localizacao;
        public String estoqueMinimo;
        public String unidade;

        public static Atual de(Product product) {
            Atual atual = new Atual();
            atual.nome = product.name;
            atual.descricao = product.description;
            atual.quantidade = product.amount;
            atual.valor = product.value;
            atual.custo = product.cost;
            atual.categoria = product.category;
            atual.sku = product.sku;
            atual.codigoBarras = product.barcode;
            atual.fornecedor = product.supplier;
            atual.localizacao = product.location;
            atual.estoqueMinimo = product.minStock;
            atual.unidade = product.unit;
            return atual;
        }

        String texto(Campo campo) {
            switch (campo) {
                case NOME: return nome;
                case DESCRICAO: return descricao;
                case QUANTIDADE: return quantidade;
                case VALOR: return valor;
                case CUSTO: return custo;
                case CATEGORIA: return categoria;
                case SKU: return sku;
                case CODIGO_BARRAS: return codigoBarras;
                case FORNECEDOR: return fornecedor;
                case LOCALIZACAO: return localizacao;
                case ESTOQUE_MINIMO: return estoqueMinimo;
                case UNIDADE: return unidade;
                default: return null;
            }
        }
    }

    /** O que a linha do arquivo informou, e só isso. */
    public static final class Entrada {
        private final EnumSet<Campo> presentes = EnumSet.noneOf(Campo.class);

        public String nome = "";
        public String descricao = "";
        public double quantidade;
        public double valor;
        public Double custo;
        public String categoria = "";
        public String sku = "";
        public String codigoBarras = "";
        public String fornecedor = "";
        public String localizacao = "";
        public double estoqueMinimo;
        public String unidade = "";

        /** Marca o campo como informado pelo arquivo. */
        public Entrada informa(Campo campo) {
            presentes.add(campo);
            return this;
        }

        public boolean informou(Campo campo) {
            return presentes.contains(campo);
        }

        public EnumSet<Campo> informados() {
            return EnumSet.copyOf(presentes);
        }

        String texto(Campo campo) {
            switch (campo) {
                case NOME: return nome;
                case DESCRICAO: return descricao;
                case CATEGORIA: return categoria;
                case SKU: return sku;
                case CODIGO_BARRAS: return codigoBarras;
                case FORNECEDOR: return fornecedor;
                case LOCALIZACAO: return localizacao;
                case UNIDADE: return unidade;
                default: return null;
            }
        }
    }

    /** O que gravar: nada além disso é tocado. */
    public static final class Resultado {
        /** Coluna do banco → valor novo, só para o que realmente mudou. */
        public final Map<String, String> colunas = new LinkedHashMap<>();
        /** A quantidade precisa de movimentação de ajuste (nunca de UPDATE). */
        public boolean quantidadeMudou;
        /** A quantidade a lançar, quando {@link #quantidadeMudou}. */
        public double quantidade;

        public boolean semMudanca() {
            return colunas.isEmpty() && !quantidadeMudou;
        }
    }

    /**
     * @param manterQuantidadeExistente o arquivo traz o histórico (backup
     *        JSON), então a quantidade nasce das movimentações e não pode ser
     *        lançada aqui como ajuste.
     */
    public static Resultado merge(Atual atual, Entrada entrada, boolean manterQuantidadeExistente) {
        Resultado resultado = new Resultado();
        if (atual == null || entrada == null) {
            return resultado;
        }

        for (Campo campo : new Campo[]{Campo.NOME, Campo.DESCRICAO, Campo.CATEGORIA, Campo.SKU,
                Campo.CODIGO_BARRAS, Campo.FORNECEDOR, Campo.LOCALIZACAO, Campo.UNIDADE}) {
            if (!entrada.informou(campo)) {
                continue;
            }
            String antes = trim(atual.texto(campo));
            String depois = trim(entrada.texto(campo));
            if (!Objects.equals(antes, depois)) {
                resultado.colunas.put(campo.coluna, depois);
            }
        }

        if (entrada.informou(Campo.VALOR)) {
            numero(resultado, Campo.VALOR, atual.valor, entrada.valor);
        }
        if (entrada.informou(Campo.CUSTO) && entrada.custo != null) {
            numero(resultado, Campo.CUSTO, atual.custo, entrada.custo);
        }
        if (entrada.informou(Campo.ESTOQUE_MINIMO)) {
            numero(resultado, Campo.ESTOQUE_MINIMO, atual.estoqueMinimo, entrada.estoqueMinimo);
        }

        if (entrada.informou(Campo.QUANTIDADE) && !manterQuantidadeExistente) {
            double antes = Quantities.parse(atual.quantidade, 0d);
            if (Double.compare(antes, entrada.quantidade) != 0) {
                resultado.quantidadeMudou = true;
                resultado.quantidade = entrada.quantidade;
            }
        }
        return resultado;
    }

    /**
     * Colunas numéricas guardadas como texto ("24.90" no banco, "24.9" no
     * arquivo exportado): comparar as strings marcava metade do cadastro como
     * "atualizado" ao reimportar a própria exportação, sem nada ter mudado.
     */
    private static void numero(Resultado resultado, Campo campo, String atual, double proximo) {
        double antes = Quantities.parse(atual, Double.NaN);
        if (Double.isNaN(antes) || Double.compare(antes, proximo) != 0) {
            resultado.colunas.put(campo.coluna, Quantities.forStorage(proximo));
        }
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
