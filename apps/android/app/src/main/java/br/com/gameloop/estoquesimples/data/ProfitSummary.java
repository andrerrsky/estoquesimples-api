package br.com.gameloop.estoquesimples.data;

/**
 * Custo, margem e lucro do estoque (versão 31).
 *
 * Só entram nas contas os produtos com custo informado: um produto sem custo
 * apareceria com 100% de margem e inflaria o lucro. Os que ficaram de fora são
 * contados para a tela dizer quantos faltam cadastrar.
 *
 * O lucro das saídas é estimado com os preços atuais do produto (a
 * movimentação não guarda o preço da época), e a tela deixa isso claro.
 */
public final class ProfitSummary {

    /** Soma de quantidade × custo dos produtos com custo. */
    public double stockAtCost;
    /** Soma de quantidade × valor de venda dos mesmos produtos. */
    public double stockAtPriceWithCost;
    /** Quanto o estoque atual renderia vendido pelo preço cadastrado. */
    public double potentialProfit;
    public int productsWithCost;
    public int productsWithoutCost;

    /** Lucro estimado das saídas (vendas) com custo conhecido. */
    public double exitsProfit;
    /** Faturamento dessas mesmas saídas. */
    public double exitsRevenueWithCost;
    /** Saídas de produtos sem custo, que ficaram fora do lucro. */
    public int exitsWithoutCost;

    /** Um produto do estoque. Quantidade negativa não conta como estoque. */
    public void addProduct(double amount, double value, Double cost) {
        if (cost == null) {
            productsWithoutCost++;
            return;
        }
        productsWithCost++;
        double quantidade = Math.max(0d, amount);
        stockAtCost += quantidade * cost;
        stockAtPriceWithCost += quantidade * value;
        potentialProfit += quantidade * (value - cost);
    }

    /** Uma saída (venda) de {@code quantity} unidades, em módulo. */
    public void addExit(double quantity, double value, Double cost) {
        double quantidade = Math.abs(quantity);
        if (cost == null) {
            exitsWithoutCost++;
            return;
        }
        exitsRevenueWithCost += quantidade * value;
        exitsProfit += quantidade * (value - cost);
    }

    public boolean hasAnyCost() {
        return productsWithCost > 0;
    }

    /** Margem do estoque com custo (lucro ÷ venda), em %; {@code null} sem base. */
    public Long potentialMarginPercent() {
        return percent(potentialProfit, stockAtPriceWithCost);
    }

    /** Margem das saídas com custo, em %; {@code null} sem base. */
    public Long exitsMarginPercent() {
        return percent(exitsProfit, exitsRevenueWithCost);
    }

    private static Long percent(double lucro, double venda) {
        if (venda <= 0) {
            return null;
        }
        return Math.round(lucro / venda * 100);
    }
}
