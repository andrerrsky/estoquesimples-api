package br.com.gameloop.estoquesimples.data;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Lotes que estão em estoque, calculados a partir das movimentações.
 *
 * Não há tabela de lotes: o que entrou com lote está no histórico, e o que
 * <i>ainda está</i> em estoque é uma conta sobre o saldo do produto — a mesma
 * do servidor, pela mesma razão (duas verdades sobre o estoque divergem na
 * primeira sincronização com conflito).
 *
 * A regra é a da prateleira: FEFO, o que vence antes sai antes. Como o que
 * sobrou é o de validade mais distante, o saldo é distribuído de trás para
 * frente — o lote que vence por último recebe primeiro. Lote sem validade
 * entra antes de todos nessa fila: não há motivo para supor que já saiu.
 *
 * Consequência desejada: a soma dos lotes nunca passa do saldo do produto, e
 * o que entrou sem lote (antes de o recurso existir) aparece como
 * {@link Resumo#semLote} em vez de ser inventado em algum lote.
 */
public final class BatchRepository {

    /** Um lote com saldo, já com o produto a que pertence. */
    public static final class Lote {
        public final String productUuid;
        public final String productName;
        public final String unit;
        public final String code;
        public final String manufacturedOn;
        /** `YYYY-MM-DD` ou nulo (lote sem validade informada). */
        public final String expiresOn;
        public final double quantity;
        /** Dias até vencer; negativo já venceu, nulo sem validade. */
        public final Integer daysToExpire;

        Lote(String productUuid, String productName, String unit, String code,
             String manufacturedOn, String expiresOn, double quantity, Integer daysToExpire) {
            this.productUuid = productUuid;
            this.productName = productName;
            this.unit = unit;
            this.code = code;
            this.manufacturedOn = manufacturedOn;
            this.expiresOn = expiresOn;
            this.quantity = quantity;
            this.daysToExpire = daysToExpire;
        }

        public boolean vencido() {
            return daysToExpire != null && daysToExpire < 0;
        }
    }

    public static final class Resumo {
        public final List<Lote> lotes;
        public final int vencidos;
        public final int vencendo;
        /** Saldo que não está em lote nenhum. */
        public final double semLote;

        Resumo(List<Lote> lotes, int vencidos, int vencendo, double semLote) {
            this.lotes = lotes;
            this.vencidos = vencidos;
            this.vencendo = vencendo;
            this.semLote = semLote;
        }
    }

    private final SQLiteDatabase db;

    public BatchRepository(SQLiteDatabase db) {
        this.db = db;
    }

    /**
     * @param productUuid um produto só, ou nulo para a empresa inteira.
     * @param janelaDias  quantos dias à frente contam como "vencendo".
     */
    public Resumo listar(String productUuid, int janelaDias) {
        List<Lote> lotes = new ArrayList<>();
        double semLote = 0d;
        int vencidos = 0;
        int vencendo = 0;

        Cursor produtos = null;
        try {
            produtos = db.rawQuery(
                    "SELECT uuid, name, unit, amount FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS
                            + (productUuid == null ? "" : " AND uuid=?"),
                    productUuid == null ? null : new String[]{productUuid});
            while (produtos.moveToNext()) {
                String uuid = produtos.getString(0);
                if (uuid == null) {
                    continue;
                }
                double saldo = Quantities.parse(produtos.getString(3));
                List<Lote> doProduto = lotesDoProduto(uuid, produtos.getString(1),
                        produtos.getString(2), saldo);
                double emLotes = 0d;
                for (Lote lote : doProduto) {
                    emLotes += lote.quantity;
                }
                if (saldo - emLotes > 0d) {
                    semLote += saldo - emLotes;
                }
                lotes.addAll(doProduto);
            }
        } finally {
            LocalDb.closeQuietly(produtos);
        }

        for (Lote lote : lotes) {
            if (lote.daysToExpire == null) {
                continue;
            }
            if (lote.daysToExpire < 0) {
                vencidos++;
            } else if (lote.daysToExpire <= janelaDias) {
                vencendo++;
            }
        }

        // O que vence primeiro na frente; sem validade por último, que é a
        // ordem em que a pessoa precisa agir na prateleira.
        Collections.sort(lotes, new Comparator<Lote>() {
            @Override
            public int compare(Lote a, Lote b) {
                if (a.expiresOn == null && b.expiresOn == null) {
                    return nome(a).compareToIgnoreCase(nome(b));
                }
                if (a.expiresOn == null) {
                    return 1;
                }
                if (b.expiresOn == null) {
                    return -1;
                }
                int porData = a.expiresOn.compareTo(b.expiresOn);
                return porData != 0 ? porData : nome(a).compareToIgnoreCase(nome(b));
            }

            private String nome(Lote lote) {
                return lote.productName == null ? "" : lote.productName;
            }
        });

        return new Resumo(lotes, vencidos, vencendo, semLote);
    }

    /** O que uma entrada deixou em um lote, antes de saber quanto ainda há. */
    public static final class Entrada {
        public final String code;
        public final String manufacturedOn;
        public final String expiresOn;
        public final double total;

        public Entrada(String code, String manufacturedOn, String expiresOn, double total) {
            this.code = code;
            this.manufacturedOn = manufacturedOn;
            this.expiresOn = expiresOn;
            this.total = total;
        }
    }

    /**
     * Distribui o saldo do produto entre as entradas, que chegam na ordem de
     * permanência (sem validade primeiro, depois da validade mais distante
     * para a mais próxima). Cada uma recebe o que as de depois não reservaram;
     * a que não recebe nada já saiu.
     *
     * Pura e pública para poder ser testada sem banco: é aqui que mora a
     * regra, e uma conta errada aqui some do estoque mercadoria que existe.
     */
    public static double[] alocar(double saldo, List<Entrada> ordenadas) {
        double[] resultado = new double[ordenadas.size()];
        double restante = Math.max(saldo, 0d);
        for (int i = 0; i < ordenadas.size() && restante > 0d; i++) {
            double neste = Math.min(ordenadas.get(i).total, restante);
            if (neste <= 0d) {
                continue;
            }
            resultado[i] = neste;
            restante -= neste;
        }
        return resultado;
    }

    private List<Lote> lotesDoProduto(String productUuid, String productName, String unit,
                                      double saldo) {
        List<Lote> resultado = new ArrayList<>();
        if (saldo <= 0d) {
            return resultado;
        }

        Cursor cursor = null;
        try {
            // Agrupado com sinal: o estorno de uma entrada carrega o mesmo
            // lote e desconta dele, em vez de deixar mercadoria devolvida
            // contando como estoque.
            cursor = db.rawQuery(
                    "SELECT batch_code, manufactured_on, expires_on, "
                            + "SUM(" + MovementRepository.SIGNED_QUANTITY_SQL + ") AS total "
                            + "FROM " + LocalDb.TABLE_MOVEMENTS
                            + " WHERE product_uuid=? AND deleted_at IS NULL "
                            + "AND (batch_code IS NOT NULL OR expires_on IS NOT NULL) "
                            + "GROUP BY batch_code, manufactured_on, expires_on "
                            + "HAVING total > 0 "
                            // Ordem de permanência: sem validade primeiro,
                            // depois da mais distante para a mais próxima.
                            + "ORDER BY (expires_on IS NULL) DESC, expires_on DESC, batch_code",
                    new String[]{productUuid});

            List<Entrada> entradas = new ArrayList<>();
            while (cursor.moveToNext()) {
                entradas.add(new Entrada(cursor.getString(0), cursor.getString(1),
                        cursor.getString(2), cursor.getDouble(3)));
            }

            double[] saldos = alocar(saldo, entradas);
            String hoje = Dias.hoje();
            for (int i = 0; i < entradas.size(); i++) {
                if (saldos[i] <= 0d) {
                    continue;
                }
                Entrada entrada = entradas.get(i);
                resultado.add(new Lote(productUuid, productName, unit, entrada.code,
                        entrada.manufacturedOn, entrada.expiresOn, saldos[i],
                        Dias.entre(hoje, entrada.expiresOn)));
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return resultado;
    }
}
