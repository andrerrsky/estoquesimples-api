package br.com.gameloop.estoquesimples.data;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Verificação do banco local antes de enviar qualquer coisa para a nuvem.
 *
 * O banco destes aparelhos acumulou anos de uso com um esquema que permitia
 * nomes repetidos, quantidades em texto livre e histórico sem produto. Enviar
 * isso sem olhar transformaria problemas locais e silenciosos em problemas
 * distribuídos e visíveis — e depois de sincronizado, o estrago já estaria em
 * todos os aparelhos da equipe.
 *
 * O relatório é mostrado ao usuário antes da primeira sincronização. Nada aqui
 * corrige nada sozinho: a decisão é de quem conhece os dados.
 */
public final class Diagnostics {

    private static final String TAG = "Diagnostics";

    private final SQLiteDatabase db;

    public Diagnostics(SQLiteDatabase db) {
        this.db = db;
    }

    public static final class Report {
        public int produtos;
        public int produtosExcluidos;
        public int movimentacoes;
        public int movimentacoesOrfas;
        public int produtosSemUuid;
        public int quantidadesInvalidas;
        public boolean integridadeOk;
        public final List<String> nomesDuplicados = new ArrayList<>();
        public final List<String> saldosDivergentes = new ArrayList<>();

        /** Nada impede o envio; os avisos são informativos. */
        public boolean isClean() {
            return integridadeOk
                    && produtosSemUuid == 0
                    && quantidadesInvalidas == 0
                    && nomesDuplicados.isEmpty()
                    && saldosDivergentes.isEmpty();
        }

        /**
         * Problemas que tornam o envio arriscado.
         *
         * Só a integridade do arquivo e a falta de identificador entram aqui.
         * Nomes repetidos e saldos divergentes são reais e comuns; avisar é
         * suficiente, bloquear seria impedir o usuário de usar o produto.
         */
        public boolean isBlocking() {
            return !integridadeOk || produtosSemUuid > 0;
        }
    }

    public Report run() {
        Report report = new Report();
        report.integridadeOk = integrityCheck();
        report.produtos = count("SELECT COUNT(*) FROM " + LocalDb.TABLE_PRODUCTS
                + " WHERE " + LocalDb.ACTIVE_PRODUCTS);
        report.produtosExcluidos = count("SELECT COUNT(*) FROM " + LocalDb.TABLE_PRODUCTS
                + " WHERE deleted_at IS NOT NULL");
        report.movimentacoes = count("SELECT COUNT(*) FROM " + LocalDb.TABLE_MOVEMENTS);
        report.movimentacoesOrfas = LocalDb.countOrphanMovements(db);
        report.produtosSemUuid = count("SELECT COUNT(*) FROM " + LocalDb.TABLE_PRODUCTS
                + " WHERE uuid IS NULL OR uuid = ''");
        report.quantidadesInvalidas = countInvalidQuantities();

        collectDuplicateNames(report);
        collectBalanceMismatches(report);
        return report;
    }

    /**
     * {@code PRAGMA integrity_check} lê o arquivo inteiro procurando páginas
     * corrompidas. É lento, mas roda uma vez antes do envio inicial, e um banco
     * corrompido é a única situação em que continuar seria pior do que parar.
     */
    private boolean integrityCheck() {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("PRAGMA integrity_check", null);
            return cursor.moveToFirst() && "ok".equalsIgnoreCase(cursor.getString(0));
        } catch (Exception e) {
            Log.e(TAG, "falha na verificação de integridade", e);
            return false;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Quantidades que não são número.
     *
     * A coluna sempre foi texto, então um "10 caixas" digitado por engano fica
     * gravado e some de qualquer soma. Localizá-las agora evita que o valor
     * chegue ao servidor como zero.
     */
    private int countInvalidQuantities() {
        Cursor cursor = null;
        int invalidas = 0;
        try {
            cursor = db.rawQuery("SELECT amount FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE " + LocalDb.ACTIVE_PRODUCTS, null);
            while (cursor.moveToNext()) {
                String bruto = cursor.getString(0);
                if (bruto == null || bruto.trim().isEmpty()) {
                    continue;
                }
                // parse devolve o padrão em caso de falha; comparar com dois
                // padrões diferentes distingue "deu zero" de "não é número".
                if (Quantities.parse(bruto, -1d) == -1d && Quantities.parse(bruto, -2d) == -2d) {
                    invalidas++;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao validar quantidades", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return invalidas;
    }

    private void collectDuplicateNames(Report report) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT name, COUNT(*) FROM " + LocalDb.TABLE_PRODUCTS
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS
                            + " GROUP BY name COLLATE NOCASE HAVING COUNT(*) > 1 "
                            + "ORDER BY COUNT(*) DESC LIMIT 20",
                    null);
            while (cursor.moveToNext()) {
                report.nomesDuplicados.add(cursor.getString(0) + " (" + cursor.getInt(1) + ")");
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao procurar nomes repetidos", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Produtos cujo saldo não corresponde à soma das movimentações.
     *
     * A divergência é esperada em quem usava o app antes do histórico completo:
     * o saldo era editado direto e nenhum evento era gravado. Serve de aviso,
     * não de erro — o saldo do aparelho continua sendo a verdade enviada.
     */
    private void collectBalanceMismatches(Report report) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT e.name, e.amount, COALESCE(soma.total, 0) FROM "
                            + LocalDb.TABLE_PRODUCTS + " e LEFT JOIN ("
                            + "  SELECT product_uuid, SUM(" + MovementRepository.SIGNED_QUANTITY_SQL
                            + ") AS total FROM " + LocalDb.TABLE_MOVEMENTS
                            + "  WHERE deleted_at IS NULL GROUP BY product_uuid"
                            + ") soma ON soma.product_uuid = e.uuid "
                            + "WHERE e." + LocalDb.ACTIVE_PRODUCTS + " LIMIT 500",
                    null);
            while (cursor.moveToNext()) {
                double saldo = Quantities.parse(cursor.getString(1));
                double somado = cursor.getDouble(2);
                // Tolerância pequena: quantidades fracionárias em ponto
                // flutuante não fecham na casa decimal exata.
                if (Math.abs(saldo - somado) > 0.001d) {
                    report.saldosDivergentes.add(
                            cursor.getString(0) + ": saldo " + saldo + ", histórico " + somado);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao comparar saldo com o histórico", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    private int count(String sql) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(sql, null);
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (Exception e) {
            Log.e(TAG, "falha ao contar registros", e);
            return 0;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }
}
