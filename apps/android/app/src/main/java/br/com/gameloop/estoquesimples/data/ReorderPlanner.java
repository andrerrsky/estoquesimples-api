package br.com.gameloop.estoquesimples.data;

import br.com.gameloop.estoquesimples.Unidades;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Lista de reposição (versão 31): o que está acabando, agrupado por
 * fornecedor, com uma quantidade sugerida e a mensagem pronta para mandar
 * pelo WhatsApp.
 *
 * Usa só o que o app já guarda (estoque mínimo e fornecedor). Entra na lista
 * o mesmo que a tela Relatórios chama de "para repor": zerado, ou no mínimo
 * ou abaixo dele.
 */
public final class ReorderPlanner {

    /** Nome do grupo de quem não tem fornecedor cadastrado. */
    public static final String SEM_FORNECEDOR = "Sem fornecedor";

    /** Um produto que precisa de reposição. */
    public static final class Item {
        public final String name;
        public final String unit;
        public final double amount;
        public final double minStock;
        public final String supplier;
        /** Quantidade a pedir; começa com a sugestão e a pessoa pode mudar. */
        public double quantity;
        /** Desmarcado = fica fora da mensagem. */
        public boolean selected = true;

        public Item(String name, String unit, double amount, double minStock, String supplier) {
            this.name = name == null ? "" : name.trim();
            this.unit = unit == null || unit.trim().isEmpty() ? "un" : unit.trim();
            this.amount = amount;
            this.minStock = minStock;
            this.supplier = supplier == null || supplier.trim().isEmpty() ? SEM_FORNECEDOR : supplier.trim();
            this.quantity = suggest(amount, minStock, this.unit);
        }
    }

    private ReorderPlanner() {
    }

    /** Mesmo critério da tela Relatórios: zerado, ou no mínimo ou abaixo. */
    public static boolean needsReorder(double amount, double minStock) {
        return amount <= 0 || (minStock > 0 && amount <= minStock);
    }

    /**
     * Quantidade sugerida: o suficiente para voltar a ter o dobro do mínimo
     * (um mínimo de 10 com 3 em estoque sugere 17), ou 1 quando não há mínimo.
     * Unidades inteiras arredondam para cima; kg e litro ficam com 2 casas.
     */
    public static double suggest(double amount, double minStock, String unit) {
        double falta = minStock > 0 ? (2 * minStock) - Math.max(0d, amount) : 1d;
        if (falta <= 0) {
            falta = minStock > 0 ? minStock : 1d;
        }
        if (isFractionalUnit(unit)) {
            return Math.round(falta * 100d) / 100d;
        }
        return Math.ceil(falta - 1e-9);
    }

    /**
     * Os {@code limit} mais urgentes: zerados primeiro, depois quem está mais
     * longe do mínimo (proporcionalmente). A lista original não é alterada.
     */
    public static List<Item> mostUrgent(List<Item> items, int limit) {
        List<Item> copia = new ArrayList<>(items);
        Collections.sort(copia, (a, b) -> Double.compare(urgency(b), urgency(a)));
        return copia.size() > limit ? new ArrayList<>(copia.subList(0, limit)) : copia;
    }

    /** Quanto maior, mais urgente: 2 = zerado, até 1 = no mínimo. */
    static double urgency(Item item) {
        if (item.amount <= 0) {
            return 2d;
        }
        return item.minStock > 0 ? 1d - (item.amount / item.minStock) + 1d - 1e-9 : 0d;
    }

    /** Agrupa por fornecedor (ordem alfabética), deixando "Sem fornecedor" por último. */
    public static Map<String, List<Item>> bySupplier(List<Item> items) {
        List<String> fornecedores = new ArrayList<>();
        Map<String, List<Item>> grupos = new LinkedHashMap<>();
        for (Item item : items) {
            if (!grupos.containsKey(item.supplier)) {
                grupos.put(item.supplier, new ArrayList<Item>());
                fornecedores.add(item.supplier);
            }
            grupos.get(item.supplier).add(item);
        }
        Collections.sort(fornecedores, (a, b) -> {
            if (a.equals(b)) return 0;
            if (SEM_FORNECEDOR.equals(a)) return 1;
            if (SEM_FORNECEDOR.equals(b)) return -1;
            return a.compareToIgnoreCase(b);
        });
        Map<String, List<Item>> ordenado = new LinkedHashMap<>();
        for (String fornecedor : fornecedores) {
            List<Item> lista = grupos.get(fornecedor);
            Collections.sort(lista, (x, y) -> x.name.compareToIgnoreCase(y.name));
            ordenado.put(fornecedor, lista);
        }
        return ordenado;
    }

    /**
     * Mensagem de pedido para um fornecedor, só com os itens marcados.
     * {@code null} quando nada foi marcado.
     */
    public static String message(String supplier, List<Item> items, String businessName) {
        StringBuilder linhas = new StringBuilder();
        for (Item item : items) {
            if (!item.selected || item.quantity <= 0) {
                continue;
            }
            linhas.append("• ").append(formatQuantity(item.quantity)).append(' ').append(item.unit)
                    .append(" — ").append(item.name).append('\n');
        }
        if (linhas.length() == 0) {
            return null;
        }
        StringBuilder texto = new StringBuilder();
        boolean comFornecedor = supplier != null && !SEM_FORNECEDOR.equals(supplier);
        texto.append(comFornecedor ? "Olá, " + supplier + "! " : "Olá! ");
        texto.append("Gostaria de fazer um pedido");
        if (businessName != null && !businessName.trim().isEmpty()) {
            texto.append(" para ").append(businessName.trim());
        }
        texto.append(":\n\n").append(linhas).append("\nObrigado!");
        return texto.toString();
    }

    /** Lista completa (todos os fornecedores), para conferir ou mandar para a equipe. */
    public static String fullList(Map<String, List<Item>> groups) {
        StringBuilder texto = new StringBuilder("Lista de reposição\n");
        for (Map.Entry<String, List<Item>> grupo : groups.entrySet()) {
            StringBuilder linhas = new StringBuilder();
            for (Item item : grupo.getValue()) {
                if (!item.selected || item.quantity <= 0) {
                    continue;
                }
                linhas.append("• ").append(formatQuantity(item.quantity)).append(' ').append(item.unit)
                        .append(" — ").append(item.name).append('\n');
            }
            if (linhas.length() > 0) {
                texto.append('\n').append(grupo.getKey()).append(":\n").append(linhas);
            }
        }
        return texto.toString().trim();
    }

    /** kg, litro, metro: pedido com fração; o resto (un, cx, pct…) é inteiro. */
    static boolean isFractionalUnit(String unit) {
        return !Unidades.inteira(unit);
    }

    /** "17", "2,5" — sem casas inúteis, vírgula decimal. */
    public static String formatQuantity(double quantity) {
        if (Math.abs(quantity - Math.rint(quantity)) < 1e-9) {
            return String.valueOf((long) Math.rint(quantity));
        }
        String texto = String.format(Locale.ROOT, "%.2f", quantity).replaceAll("0+$", "").replaceAll("\\.$", "");
        return texto.replace('.', ',');
    }
}
