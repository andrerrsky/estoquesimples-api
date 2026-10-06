package br.com.gameloop.estoquesimples.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

/**
 * Estado da sincronização, guardado no próprio banco de dados.
 *
 * Fica aqui, e não em SharedPreferences, por causa do cursor: ele precisa
 * avançar na mesma transação que aplica as alterações recebidas. Se o cursor
 * vivesse fora do banco, uma queda entre "aplicar o lote" e "salvar o cursor"
 * faria o app reprocessar ou pular alterações, dependendo da ordem escolhida —
 * e não existe ordem que evite os dois.
 */
public final class SyncMeta {

    private static final String TAG = "SyncMeta";

    /** Última posição confirmada na sequência de alterações do servidor. */
    public static final String CURSOR = "cursor";
    /** Empresa cujos dados estão neste aparelho. */
    public static final String WORKSPACE_ID = "workspace_id";
    /** Momento da última sincronização concluída com sucesso. */
    public static final String ULTIMA_SINCRONIZACAO = "ultima_sincronizacao";
    /** Resultado da última tentativa, para a tela de status. */
    public static final String ULTIMO_ERRO = "ultimo_erro";
    /** Marca que o envio inicial terminou; sem isso, nada incremental começa. */
    public static final String CARGA_INICIAL_CONCLUIDA = "carga_inicial_concluida";
    /** Sessão de envio inicial em andamento, para retomar de onde parou. */
    public static final String UPLOAD_ID = "upload_id";
    public static final String UPLOAD_PROXIMO_LOTE = "upload_proximo_lote";
    /** Diferença entre o relógio do aparelho e o do servidor, em milissegundos. */
    public static final String DESVIO_RELOGIO = "desvio_relogio";
    /** Conflitos esperando decisão de uma pessoa na última sincronização. */
    public static final String CONFLITOS_PENDENTES = "conflitos_pendentes";
    /** Mensagem do servidor quando o plano travou a sincronização (teto ou equipe). */
    public static final String BLOQUEIO_PLANO = "bloqueio_plano";
    /**
     * Aviso discreto sobre fotos que não puderam subir (cota de armazenamento,
     * permissão). Não pausa o estoque; aparece só no status da tela de conta.
     */
    public static final String FOTOS_AVISO = "fotos_aviso";

    private final SQLiteDatabase db;

    public SyncMeta(SQLiteDatabase db) {
        this.db = db;
    }

    public String get(String chave) {
        return get(chave, null);
    }

    public String get(String chave, String padrao) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT valor FROM " + LocalDb.TABLE_SYNC_META + " WHERE chave=?",
                    new String[]{chave});
            return cursor.moveToFirst() ? cursor.getString(0) : padrao;
        } catch (Exception e) {
            Log.e(TAG, "falha ao ler " + chave, e);
            return padrao;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
    }

    public long getLong(String chave, long padrao) {
        String valor = get(chave);
        if (valor == null) {
            return padrao;
        }
        try {
            return Long.parseLong(valor);
        } catch (NumberFormatException e) {
            return padrao;
        }
    }

    public boolean getBoolean(String chave, boolean padrao) {
        String valor = get(chave);
        return valor == null ? padrao : Boolean.parseBoolean(valor);
    }

    public void put(String chave, String valor) {
        if (valor == null) {
            db.delete(LocalDb.TABLE_SYNC_META, "chave=?", new String[]{chave});
            return;
        }
        ContentValues values = new ContentValues();
        values.put("chave", chave);
        values.put("valor", valor);
        db.insertWithOnConflict(LocalDb.TABLE_SYNC_META, null, values,
                SQLiteDatabase.CONFLICT_REPLACE);
    }

    public void put(String chave, long valor) {
        put(chave, String.valueOf(valor));
    }

    public void put(String chave, boolean valor) {
        put(chave, String.valueOf(valor));
    }

    public void remove(String chave) {
        put(chave, (String) null);
    }

    /**
     * Apaga o estado de sincronização sem tocar nos dados do usuário.
     *
     * Usada no logout e na troca de empresa. Produtos e movimentações
     * permanecem: o app funcionava sem conta antes e continua funcionando
     * depois de sair dela.
     */
    public void clear() {
        db.delete(LocalDb.TABLE_SYNC_META, null, null);
    }
}
