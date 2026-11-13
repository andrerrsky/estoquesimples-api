package br.com.gameloop.estoquesimples.data;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Acerto de abertura: faz o histórico do aparelho fechar com o saldo que ele
 * mostra, antes que esses dados subam para a nuvem.
 *
 * <p><b>Por que existe.</b> No aparelho, a quantidade de cada produto é um
 * campo da própria linha ({@code Estoque.amount}); na nuvem, o saldo é a soma
 * das movimentações (ver a regra 9 do AGENTS.md da raiz). Os dois só coincidem
 * se todo o histórico estiver no aparelho — e em muitos não está: bancos de
 * versões antigas, estoques montados antes de o app registrar cada alteração,
 * restaurações de cópia parcial. Nesses casos a carga inicial enviava produtos
 * e movimentações fiéis ao aparelho, mas a nuvem calculava um saldo menor (ou
 * maior) e a aplicação web mostrava números diferentes dos do celular, sem
 * nenhum erro aparente — o cliente via o próprio estoque "errado" e não tinha
 * como corrigir.
 *
 * <p><b>O que faz.</b> Para cada produto ativo cuja soma do histórico não bate
 * com a quantidade mostrada, grava uma movimentação de {@code ajuste} com
 * exatamente a diferença. O saldo do aparelho <b>não muda</b> (ele já é o
 * certo); o que muda é o histórico, que passa a explicá-lo. Como toda
 * movimentação, o ajuste entra na fila de sincronização e leva o saldo correto
 * para a nuvem.
 *
 * <p>Roda uma única vez por aparelho ({@code SyncMeta.ACERTO_ABERTURA}), com a
 * sincronização já ligada e antes da carga inicial.
 */
public final class OpeningBalance {

    private static final String TAG = "OpeningBalance";

    /** Observação gravada no ajuste, visível no histórico do cliente. */
    static final String NOTE = "Acerto do saldo inicial";

    /**
     * Diferenças menores que isto são ruído de ponto flutuante (0,1 g, 0,001
     * unidade) e não merecem uma linha no histórico de ninguém.
     */
    static final double TOLERANCE = 0.0001d;

    private OpeningBalance() {
    }

    /** Um produto cujo histórico não explica o saldo. */
    public static final class Gap {
        public final String productUuid;
        public final String productName;
        /** Quanto falta no histórico: positivo se o saldo é maior que a soma. */
        public final double delta;

        Gap(String productUuid, String productName, double delta) {
            this.productUuid = productUuid;
            this.productName = productName;
            this.delta = delta;
        }
    }

    /** Vale a pena gravar um ajuste para esta diferença? */
    public static boolean worthAdjusting(double delta) {
        return Math.abs(delta) >= TOLERANCE;
    }

    /**
     * Produtos ativos em que a soma do histórico difere do saldo mostrado.
     *
     * Produtos excluídos ficam de fora: a lápide já viaja para a nuvem e o
     * saldo deles não é mostrado a ninguém.
     */
    public static List<Gap> gaps(SQLiteDatabase db) {
        List<Gap> encontrados = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT p.uuid, p.name, p.amount, coalesce(("
                            + " SELECT SUM(" + MovementRepository.SIGNED_QUANTITY_SQL + ")"
                            + " FROM " + LocalDb.TABLE_MOVEMENTS + " m WHERE m.product_uuid = p.uuid"
                            + "), 0) AS somado"
                            + " FROM " + LocalDb.TABLE_PRODUCTS + " p"
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS,
                    null);
            while (cursor.moveToNext()) {
                String uuid = cursor.getString(0);
                if (uuid == null) {
                    continue;
                }
                double saldo = Quantities.parse(cursor.getString(2));
                double somado = cursor.getDouble(3);
                double delta = saldo - somado;
                if (worthAdjusting(delta)) {
                    encontrados.add(new Gap(uuid, cursor.getString(1), delta));
                }
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "falha ao conferir o saldo inicial", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return encontrados;
    }

    /**
     * Grava os ajustes que faltam e devolve quantos foram. Cada produto é uma
     * transação própria: um produto problemático não impede o acerto dos
     * outros.
     */
    public static int reconcile(SQLiteDatabase db) {
        List<Gap> pendentes = gaps(db);
        if (pendentes.isEmpty()) {
            return 0;
        }
        MovementRepository movimentacoes = new MovementRepository(db);
        int gravados = 0;
        for (Gap gap : pendentes) {
            MovementRepository.Result resultado = movimentacoes.ledgerGapAdjustment(gap.productUuid, gap.delta, NOTE);
            if (resultado.success) {
                gravados++;
            } else {
                Log.w(TAG, "não foi possível acertar " + gap.productName + ": " + resultado.message);
            }
        }
        Log.i(TAG, "acerto do saldo inicial: " + gravados + " de " + pendentes.size());
        return gravados;
    }
}
