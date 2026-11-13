package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.data.Quantities;
import br.com.gameloop.estoquesimples.data.SyncMeta;
import br.com.gameloop.estoquesimples.data.SyncPayloads;

/**
 * Confere o saldo deste aparelho contra o da nuvem e reenvia as movimentações
 * que nunca chegaram lá.
 *
 * <p><b>Por que existe.</b> Os dois lados guardam o saldo de formas
 * diferentes: aqui é um campo da linha do produto, na nuvem é a soma das
 * movimentações (regra 9 do AGENTS.md da raiz). Cada lado fica internamente
 * coerente, então uma movimentação que exista só de um lado nunca é
 * percebida. Foi assim que um cliente passou a ver 12 no tablet e 5 no site,
 * sem erro nenhum, e quase cancelou a assinatura.
 *
 * <p><b>Como acerta.</b> Em duas etapas. Primeiro pede o saldo de cada produto
 * ({@code GET /sync/balances}) e separa os que não batem. Depois, só para
 * esses, pede os identificadores das movimentações que a nuvem tem
 * ({@code .../movements}) e <b>reenfileira as locais que faltam lá</b>.
 *
 * <p>Repor os fatos, e não gravar um ajuste com a diferença, é o ponto
 * central deste desenho. Um ajuste sintético resolveria o número e estragaria
 * tudo em volta: o histórico deste aparelho passaria a somar mais do que o
 * saldo que ele mostra, o diagnóstico de divergência acusaria erro em todos
 * os produtos conferidos, e reimportar uma cópia exportada inflaria o estoque
 * — o mesmo defeito que tirou a versão 35 da revisão da loja.
 *
 * <p><b>Quando é seguro.</b> Só roda quando nada além de um defeito pode
 * explicar a diferença:
 * <ul>
 *   <li>a empresa da sessão é a mesma que este banco vinha sincronizando;</li>
 *   <li>a carga inicial terminou (antes dela o saldo sobe declarado);</li>
 *   <li>a fila está vazia, antes e depois da leitura — nada em voo;</li>
 *   <li>o cursor deste aparelho está na posição que a conferência reportou;</li>
 *   <li>o histórico local explica o saldo local: um aparelho cujos próprios
 *       livros não fecham não tem autoridade para corrigir a nuvem;</li>
 *   <li>a divergência é pontual. Catálogo inteiro divergente é sinal de banco
 *       local errado, não de nuvem errada: nesse caso só reporta.</li>
 * </ul>
 * Qualquer condição falhando, a rodada é abandonada sem gravar nada.
 */
public final class BalanceAudit {

    private static final String TAG = "BalanceAudit";

    /** Abaixo disto a diferença é ruído de ponto flutuante, não um defeito. */
    static final double TOLERANCIA = MovementRepository.ACERTO_MINIMO;

    /** Uma vez por dia basta: a divergência não nasce entre duas rodadas. */
    static final long INTERVALO_MS = 24L * 3_600_000L;

    /**
     * Acima disto, quem está errado provavelmente é este aparelho. Reportamos
     * e não tocamos em nada — reescrever a nuvem em massa a partir de um banco
     * local suspeito faria estrago muito maior do que o número errado.
     */
    static final int MAX_PRODUTOS_DIVERGENTES = 20;

    /**
     * Teto de movimentações reenfileiradas por rodada.
     *
     * Vinte produtos com histórico longo somam dezenas de milhares de
     * registros; enfileirar tudo de uma vez estouraria o tempo do worker e
     * entupiria a fila de envio. O que sobrar vai na conferência seguinte.
     */
    static final int MAX_REPAROS = 200;

    /**
     * Espera depois de uma rodada abandonada já com o catálogo baixado.
     *
     * Sem isto, um aparelho cujo cursor nunca coincide — empresa com outro
     * tablet vendendo o dia inteiro — rebaixaria o catálogo inteiro a cada
     * rodada de sincronização, para sempre, sem nunca concluir nada.
     */
    static final long BACKOFF_MS = 60L * 60_000L;

    private final Context context;
    private final SQLiteDatabase db;
    private final ApiClient api;
    private final SessionManager session;
    private final SyncMeta meta;
    /** O worker pediu parada no meio de uma leitura paginada. */
    private boolean paradaPedida;

    public BalanceAudit(Context context, SQLiteDatabase db, ApiClient api, SessionManager session) {
        this.context = context.getApplicationContext();
        this.db = db;
        this.api = api;
        this.session = session;
        this.meta = new SyncMeta(db);
    }

    /** Resultado de uma conferência. */
    public static final class Resultado {
        /** Produtos cujo saldo não batia com o da nuvem. */
        public final int divergentes;
        /** Movimentações reenfileiradas (sobem na próxima rodada). */
        public final int reenviadas;
        /** A conferência chegou a rodar? Falso quando as condições não permitiam. */
        public final boolean executou;

        Resultado(int divergentes, int reenviadas, boolean executou) {
            this.divergentes = divergentes;
            this.reenviadas = reenviadas;
            this.executou = executou;
        }

        static Resultado naoExecutou() {
            return new Resultado(0, 0, false);
        }
    }

    /**
     * Já passou tempo suficiente desde a última conferência?
     *
     * Marca no futuro (relógio do aparelho adiantado e depois corrigido) conta
     * como "está na hora": o contrário deixaria o aparelho sem conferir até a
     * data gravada chegar, que pode ser daqui a anos.
     */
    static boolean estaNaHora(long ultima, long agora) {
        return ultima > agora || agora - ultima >= INTERVALO_MS;
    }

    /**
     * Maior rowid da tabela de movimentações. Usado como marca de fronteira
     * entre o histórico legado e o que nasceu depois da carga inicial.
     */
    public static long ultimaMovimentacaoGravada(SQLiteDatabase db) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT coalesce(max(rowid), 0) FROM " + LocalDb.TABLE_MOVEMENTS, null);
            return cursor.moveToFirst() ? cursor.getLong(0) : 0L;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    /**
     * Confere e repara. Faz rede; nunca chamar na thread principal.
     *
     * @param interrupcao sinal de parada do worker, consultado entre páginas.
     */
    public Resultado run(Interrupcao interrupcao) {
        String workspaceId = session.workspaceId();
        if (workspaceId == null
                || !workspaceId.equals(meta.get(SyncMeta.WORKSPACE_ID))
                || !meta.getBoolean(SyncMeta.CARGA_INICIAL_CONCLUIDA, false)
                || meta.getBoolean(SyncMeta.CONFERENCIA_SALDO_PROIBIDA, false)
                || !estaNaHora(meta.getLong(SyncMeta.ULTIMA_CONFERENCIA_SALDO, 0L), System.currentTimeMillis())) {
            return Resultado.naoExecutou();
        }

        // Fronteira entre o histórico que subiu como saldo declarado e os
        // fatos que vieram depois. Quem fechou a carga já nesta versão tem a
        // marca exata (o rowid do momento); quem fechou antes não tem, e aí
        // vale a data que o servidor informa — cortar por "agora" deixaria
        // todo o estoque atual fora do reparo e a correção nasceria inerte
        // justamente na base que motivou o incidente.
        long corteRowid = meta.getLong(SyncMeta.CORTE_CARGA_INICIAL, -1L);

        try {
            OutboxRepository outbox = new OutboxRepository(db);
            long marcaAntes = outbox.maxId();
            Set<String> naFila = produtosComOperacaoNaFila();

            Map<String, Double> daNuvem = new HashMap<>();
            Retrato retrato = baixarSaldos(workspaceId, daNuvem, interrupcao);
            if (retrato == null) {
                // A leitura já custou páginas: repeti-la na próxima rodada de
                // sincronização sairia caro e provavelmente daria no mesmo.
                return adiar();
            }
            String changeSeq = retrato.changeSeq;

            // A leitura leva páginas e segundos. Uma operação nascida nesse
            // meio-tempo explicaria sozinha qualquer diferença, então a rodada
            // é descartada. A contagem da fila não serviria: uma operação que
            // entra e é enviada dentro da janela a deixa como estava.
            long marcaDepois = outbox.maxId();
            if (marcaAntes < 0 || marcaDepois != marcaAntes) {
                Log.d(TAG, "conferência adiada: a fila mudou durante a leitura");
                return adiar();
            }
            // Quem estava na fila no começo e saiu no meio também fica de
            // fora: a nuvem pode ainda não ter gravado o que acabou de subir.
            naFila.addAll(produtosComOperacaoNaFila());

            // O cursor precisa estar exatamente onde a conferência foi tirada:
            // mais atrás e existe alteração por baixar que explicaria tudo.
            String cursorLocal = meta.get(SyncMeta.CURSOR, "0");
            if (!changeSeq.equals(cursorLocal)) {
                Log.d(TAG, "conferência adiada: cursor " + cursorLocal + " ≠ posição " + changeSeq);
                return adiar();
            }

            List<String> divergentes = comparar(daNuvem, naFila);
            if (divergentes.isEmpty()) {
                // Também o resultado bom é reportado: sem o denominador não
                // dá para saber se a conferência está rodando na frota.
                Analytics.track(context, "sync.balance_checked",
                        Analytics.props("products", daNuvem.size(), "mismatched", 0));
                meta.put(SyncMeta.ULTIMA_CONFERENCIA_SALDO, System.currentTimeMillis());
                return new Resultado(0, 0, true);
            }

            if (divergentes.size() > MAX_PRODUTOS_DIVERGENTES) {
                // Não é um produto que escapou: é o banco local fora do lugar.
                Log.w(TAG, "conferência: " + divergentes.size() + " produtos divergentes; só reportando");
                Analytics.track(context, "sync.balance_mismatch",
                        Analytics.props("products", divergentes.size(), "repaired", 0));
                meta.put(SyncMeta.ULTIMA_CONFERENCIA_SALDO, System.currentTimeMillis());
                return new Resultado(divergentes.size(), 0, true);
            }

            int reenviadas = 0;
            int semReparo = 0;
            for (String productUuid : divergentes) {
                if (reenviadas >= MAX_REPAROS || interrupcao.pediuParada()) {
                    // O que sobrou fica para a próxima: nada se perde, e o
                    // worker não estoura o tempo que o sistema lhe dá.
                    Log.i(TAG, "conferência interrompida após " + reenviadas + " reenvio(s)");
                    return adiar();
                }
                Reparo reparo = reenviarMovimentacoesAusentes(workspaceId, productUuid, corteRowid,
                        retrato.seededAt, MAX_REPAROS - reenviadas, interrupcao);
                reenviadas += reparo.enfileiradas;
                if (reparo.nadaReponivel) {
                    semReparo++;
                }
                if (paradaPedida) {
                    // Sair pelo carimbo cheio aqui esconderia por 24h uma
                    // rodada que não chegou ao fim.
                    return adiar();
                }
            }

            // "Detectado" e "reparável" são números diferentes, e é a
            // distância entre eles que diz se a correção está funcionando em
            // campo: divergência que ninguém consegue repor continua errada
            // na tela do cliente, e sem este contador ninguém saberia.
            Analytics.track(context, "sync.balance_mismatch", Analytics.props(
                    "products", divergentes.size(),
                    "repaired", reenviadas,
                    "unrepairable", semReparo));
            meta.put(SyncMeta.ULTIMA_CONFERENCIA_SALDO, System.currentTimeMillis());
            Log.i(TAG, "conferência de saldo: " + divergentes.size() + " divergente(s), "
                    + reenviadas + " movimentação(ões) reenviada(s)");
            return new Resultado(divergentes.size(), reenviadas, true);
        } catch (ApiException e) {
            // Só a falta de permissão é definitiva. Assinatura em atraso e
            // sincronização desligada também chegam como 403, e são estados
            // que passam: desligar a conferência por causa deles a mataria
            // em silêncio num cartão recusado, sem nunca mais voltar.
            if (ApiException.PERMISSAO_NEGADA.equals(e.getCode())) {
                Log.i(TAG, "conferência de saldo desligada: conta sem acesso ao histórico");
                meta.put(SyncMeta.CONFERENCIA_SALDO_PROIBIDA, true);
                return Resultado.naoExecutou();
            }
            Log.d(TAG, "conferência de saldo indisponível: " + e.getCode());
            return adiar();
        } catch (RuntimeException e) {
            // Defeito nosso tende a se repetir igual; esperar o intervalo
            // cheio evita refazer o download a cada rodada por nada.
            Log.e(TAG, "falha na conferência de saldo", e);
            meta.put(SyncMeta.ULTIMA_CONFERENCIA_SALDO, System.currentTimeMillis());
            return Resultado.naoExecutou();
        }
    }

    /**
     * Marca a rodada como gasta por um tempo menor que o intervalo cheio.
     *
     * Serve para os abandonos que já custaram rede: a próxima tentativa fica
     * para daqui a {@link #BACKOFF_MS}, em vez de repetir o download do
     * catálogo na rodada de sincronização seguinte.
     */
    private Resultado adiar() {
        meta.put(SyncMeta.ULTIMA_CONFERENCIA_SALDO,
                System.currentTimeMillis() - INTERVALO_MS + BACKOFF_MS);
        return Resultado.naoExecutou();
    }

    /** O que a nuvem informou junto com os saldos. */
    private static final class Retrato {
        final String changeSeq;
        /** Fechamento da carga inicial, em milissegundos; 0 se não houve. */
        final long seededAt;

        Retrato(String changeSeq, long seededAt) {
            this.changeSeq = changeSeq;
            this.seededAt = seededAt;
        }
    }

    /**
     * Baixa todas as páginas de saldo, ou devolve {@code null} se a empresa
     * mudou no meio da leitura — nesse caso o retrato está rasgado e não
     * serve para comparar.
     */
    private Retrato baixarSaldos(String workspaceId, Map<String, Double> destino, Interrupcao interrupcao)
            throws ApiException {
        String after = null;
        String changeSeq = null;
        long seededAt = 0L;
        for (int pagina = 0; pagina < 200; pagina++) {
            if (interrupcao.pediuParada()) {
                return null;
            }
            String caminho = "/v1/workspaces/" + workspaceId + "/sync/balances"
                    + (after == null ? "" : "?after=" + after);
            JSONObject corpo = api.get(caminho, session.accessToken()).body;

            String posicao = corpo.optString("changeSeq", "");
            if (changeSeq == null) {
                changeSeq = posicao;
                seededAt = corpo.optLong("seededAt", 0L);
            } else if (!changeSeq.equals(posicao)) {
                Log.d(TAG, "a empresa mudou durante a leitura; conferência adiada");
                return null;
            }

            JSONArray itens = corpo.optJSONArray("items");
            if (itens != null) {
                for (int i = 0; i < itens.length(); i++) {
                    JSONObject item = itens.optJSONObject(i);
                    if (item == null) {
                        continue;
                    }
                    String id = item.optString("id", null);
                    if (id != null) {
                        destino.put(id, Quantities.parse(item.optString("quantity", "0")));
                    }
                }
            }

            if (!corpo.optBoolean("hasMore", false)) {
                return new Retrato(changeSeq, seededAt);
            }
            after = corpo.optString("nextAfter", null);
            if (after == null || after.isEmpty()) {
                return new Retrato(changeSeq, seededAt);
            }
        }
        Log.w(TAG, "conferência interrompida: páginas demais");
        return null;
    }

    /**
     * Produtos vivos daqui cujo saldo difere do da nuvem <b>e</b> cujo
     * histórico local explica o saldo local.
     *
     * Essa segunda condição é o que separa "a nuvem perdeu um fato" de "este
     * banco está corrompido". Só no primeiro caso há o que reenviar; no
     * segundo, reescrever a nuvem espalharia o estrago.
     *
     * Produto que a nuvem não conhece fica de fora: ou ainda vai subir, ou foi
     * excluído lá. O mesmo para produto com operação na fila: a diferença
     * pode ser exatamente o que ainda não chegou.
     */
    private List<String> comparar(Map<String, Double> daNuvem, Set<String> naFila) {
        List<String> divergentes = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT p.uuid, p.amount, coalesce(("
                            + " SELECT SUM(" + MovementRepository.SIGNED_QUANTITY_SQL + ")"
                            + " FROM " + LocalDb.TABLE_MOVEMENTS + " m"
                            + " WHERE m.product_uuid = p.uuid AND m.deleted_at IS NULL"
                            + "), 0) AS somado"
                            + " FROM " + LocalDb.TABLE_PRODUCTS + " p"
                            + " WHERE " + LocalDb.ACTIVE_PRODUCTS,
                    null);
            while (cursor.moveToNext()) {
                String uuid = cursor.getString(0);
                if (uuid == null) {
                    continue;
                }
                Double saldoNaNuvem = daNuvem.get(uuid);
                if (saldoNaNuvem == null || naFila.contains(uuid)) {
                    continue;
                }
                double saldoLocal = Quantities.parse(cursor.getString(1));
                if (Math.abs(saldoLocal - cursor.getDouble(2)) >= TOLERANCIA) {
                    // Os livros deste aparelho não fecham entre si: não é ele
                    // quem vai dizer à nuvem qual é o saldo certo.
                    continue;
                }
                if (Math.abs(saldoLocal - saldoNaNuvem) >= TOLERANCIA) {
                    divergentes.add(uuid);
                }
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return divergentes;
    }

    /**
     * Produtos que têm alguma operação na fila de envio — diretamente, ou por
     * uma movimentação sua. São os únicos em que uma diferença pode ter
     * explicação inocente.
     */
    private Set<String> produtosComOperacaoNaFila() {
        Set<String> ids = new HashSet<>();
        Cursor cursor = null;
        try {
            // Só o que ainda vai subir. Operação recusada em definitivo não
            // entra: o produto dela é o candidato mais provável a estar
            // divergente, e ignorá-lo o deixaria sem conferência para sempre
            // — exatamente o aparelho que mais precisa dela.
            cursor = db.rawQuery(
                    "SELECT entity_id FROM " + LocalDb.TABLE_OUTBOX
                            + " WHERE entity_type=? AND status=?"
                            + " UNION"
                            + " SELECT m.product_uuid FROM " + LocalDb.TABLE_OUTBOX + " o"
                            + " JOIN " + LocalDb.TABLE_MOVEMENTS + " m ON m.uuid = o.entity_id"
                            + " WHERE o.entity_type=? AND o.status=?",
                    new String[]{OutboxRepository.ENTITY_PRODUTO, OutboxRepository.STATUS_PENDENTE,
                            OutboxRepository.ENTITY_MOVIMENTACAO, OutboxRepository.STATUS_PENDENTE});
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                if (id != null) {
                    ids.add(id);
                }
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return ids;
    }

    /**
     * Reenfileira as movimentações locais deste produto que a nuvem não tem.
     *
     * @param corteRowid rowid da última movimentação anterior ao fim da carga
     *     inicial, ou negativo se este aparelho fechou a carga antes de a
     *     marca existir. Nada igual ou abaixo dele é reenviado: esse
     *     histórico já está contado no saldo declarado que a carga enviou, e
     *     repeti-lo somaria duas vezes na nuvem.
     * @param seededAt quando a carga fechou, segundo o servidor. Usado no
     *     lugar do rowid quando ele não existe: é menos preciso, mas abre a
     *     janela real em vez de barrar todo o histórico já gravado.
     * @param teto quantas ainda cabem nesta rodada.
     */
    private Reparo reenviarMovimentacoesAusentes(
            String workspaceId, String productUuid, long corteRowid, long seededAt, int teto,
            Interrupcao interrupcao) throws ApiException {
        Set<String> naNuvem = baixarIdsDeMovimentacoes(workspaceId, productUuid, interrupcao);
        if (naNuvem == null) {
            // Histórico que não coube nas páginas lidas conta como não
            // reponível: é uma divergência que fica, e some das duas
            // contagens se não for registrada — logo no produto mais
            // movimentado da conta, que é onde ela mais custa. Parada do
            // worker não conta: ali não se chegou a concluir nada.
            return new Reparo(0, !paradaPedida);
        }

        List<String> ausentes = new ArrayList<>();
        Cursor cursor = null;
        try {
            // A operação já enfileirada fica de fora, inclusive a recusada em
            // definitivo: enfileirar de novo o que o servidor já rejeitou só
            // criaria um reenvio diário que nunca muda nada.
            String corte;
            String valorDoCorte;
            if (corteRowid >= 0L) {
                corte = "m.rowid > ?";
                valorDoCorte = String.valueOf(corteRowid);
            } else if (seededAt > 0L) {
                corte = "m.timestamp > ?";
                valorDoCorte = String.valueOf(seededAt);
            } else {
                // Empresa que nunca fez carga inicial: todo o histórico subiu
                // um a um, então todo ele é reponível.
                corte = "1=1";
                valorDoCorte = null;
            }
            String sql = "SELECT m.uuid FROM " + LocalDb.TABLE_MOVEMENTS + " m"
                    + " WHERE m.product_uuid=? AND m.deleted_at IS NULL AND " + corte
                    + " AND NOT EXISTS (SELECT 1 FROM " + LocalDb.TABLE_OUTBOX + " o"
                    + " WHERE o.entity_id = m.uuid)"
                    + " ORDER BY m.rowid";
            cursor = db.rawQuery(sql, valorDoCorte == null
                    ? new String[]{productUuid}
                    : new String[]{productUuid, valorDoCorte});
            while (cursor.moveToNext() && ausentes.size() < teto) {
                String uuid = cursor.getString(0);
                if (uuid != null && !naNuvem.contains(uuid)) {
                    ausentes.add(uuid);
                }
            }
        } finally {
            LocalDb.closeQuietly(cursor);
        }

        if (ausentes.isEmpty()) {
            // O saldo difere mas o histórico é o mesmo dos dois lados: isso é
            // a nuvem com o cache fora do lugar, não um fato que falta aqui.
            // Não há nada que este aparelho possa fazer sem inventar dado.
            Log.w(TAG, "saldo divergente sem movimentação reponível em " + productUuid);
            return new Reparo(0, true);
        }

        int enfileiradas = 0;
        OutboxRepository outbox = new OutboxRepository(db);
        for (String movimentacao : ausentes) {
            db.beginTransaction();
            try {
                JSONObject payload = SyncPayloads.movement(db, movimentacao);
                if (payload != null
                        && outbox.enqueue(OutboxRepository.ENTITY_MOVIMENTACAO, movimentacao,
                        OutboxRepository.OP_MOVEMENT, null, payload.toString()) != null) {
                    db.setTransactionSuccessful();
                    enfileiradas++;
                }
            } finally {
                db.endTransaction();
            }
        }
        return new Reparo(enfileiradas, false);
    }

    /** O que saiu da tentativa de repor um produto. */
    private static final class Reparo {
        final int enfileiradas;
        /** Diverge, e não há fato local que explique a diferença. */
        final boolean nadaReponivel;

        Reparo(int enfileiradas, boolean nadaReponivel) {
            this.enfileiradas = enfileiradas;
            this.nadaReponivel = nadaReponivel;
        }
    }

    /** Ids das movimentações que a nuvem tem, ou {@code null} se não deu para ler. */
    private Set<String> baixarIdsDeMovimentacoes(String workspaceId, String productUuid,
                                                 Interrupcao interrupcao) throws ApiException {
        Set<String> ids = new HashSet<>();
        String after = null;
        for (int pagina = 0; pagina < 200; pagina++) {
            if (interrupcao.pediuParada()) {
                paradaPedida = true;
                return null;
            }
            String caminho = "/v1/workspaces/" + workspaceId + "/sync/balances/" + productUuid + "/movements"
                    + (after == null ? "" : "?after=" + after);
            JSONObject corpo = api.get(caminho, session.accessToken()).body;

            JSONArray itens = corpo.optJSONArray("items");
            if (itens != null) {
                for (int i = 0; i < itens.length(); i++) {
                    String id = itens.optString(i, null);
                    if (id != null && !id.isEmpty()) {
                        ids.add(id);
                    }
                }
            }

            if (!corpo.optBoolean("hasMore", false)) {
                return ids;
            }
            after = corpo.optString("nextAfter", null);
            if (after == null || after.isEmpty()) {
                return ids;
            }
        }
        Log.w(TAG, "histórico do produto " + productUuid + " não coube nas páginas lidas");
        return null;
    }
}
