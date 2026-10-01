package br.com.gameloop.estoquesimples.analytics;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

/**
 * Fila local de eventos de uso, num banco próprio ({@code analytics.db}).
 *
 * Separado do banco {@code estoque} de propósito: restaurar uma cópia ou
 * importar um .db substitui aquele arquivo inteiro, e a fila de eventos não
 * pode ser sobrescrita nem sair junto numa exportação do estoque. Um evento
 * de uso é telemetria do app, não dado do cliente.
 */
final class AnalyticsDb extends SQLiteOpenHelper {

    private static final String NOME = "analytics";
    private static final int VERSAO = 1;
    static final String TABELA = "analytics_outbox";

    private static AnalyticsDb instancia;

    static synchronized AnalyticsDb helper(Context context) {
        if (instancia == null) {
            instancia = new AnalyticsDb(context.getApplicationContext());
        }
        return instancia;
    }

    private AnalyticsDb(Context context) {
        super(context, NOME, null, VERSAO);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + TABELA + " ("
                + "id TEXT PRIMARY KEY, "
                + "name TEXT NOT NULL, "
                + "occurred_at INTEGER NOT NULL, "
                + "workspace_id TEXT, "
                + "session_key TEXT, "
                + "properties TEXT, "
                + "attempts INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE INDEX IF NOT EXISTS analytics_outbox_time ON " + TABELA + " (occurred_at)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        onCreate(db);
    }

    /** Um evento aguardando envio. */
    static final class Pendente {
        final String id;
        final String name;
        final long occurredAt;
        final String workspaceId;
        final String sessionKey;
        final String properties;

        Pendente(String id, String name, long occurredAt, String workspaceId,
                 String sessionKey, String properties) {
            this.id = id;
            this.name = name;
            this.occurredAt = occurredAt;
            this.workspaceId = workspaceId;
            this.sessionKey = sessionKey;
            this.properties = properties;
        }
    }

    void inserir(Pendente evento) {
        ContentValues values = new ContentValues();
        values.put("id", evento.id);
        values.put("name", evento.name);
        values.put("occurred_at", evento.occurredAt);
        values.put("workspace_id", evento.workspaceId);
        values.put("session_key", evento.sessionKey);
        values.put("properties", evento.properties);
        getWritableDatabase().insertWithOnConflict(TABELA, null, values,
                SQLiteDatabase.CONFLICT_IGNORE);
    }

    List<Pendente> proximos(int limite) {
        List<Pendente> lista = new ArrayList<>();
        Cursor cursor = getReadableDatabase().query(TABELA,
                new String[]{"id", "name", "occurred_at", "workspace_id", "session_key", "properties"},
                null, null, null, null, "occurred_at ASC", String.valueOf(limite));
        try {
            while (cursor.moveToNext()) {
                lista.add(new Pendente(
                        cursor.getString(0),
                        cursor.getString(1),
                        cursor.getLong(2),
                        cursor.isNull(3) ? null : cursor.getString(3),
                        cursor.isNull(4) ? null : cursor.getString(4),
                        cursor.isNull(5) ? null : cursor.getString(5)));
            }
        } finally {
            cursor.close();
        }
        return lista;
    }

    long pendentes() {
        Cursor cursor = getReadableDatabase().rawQuery("SELECT count(*) FROM " + TABELA, null);
        try {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0;
        } finally {
            cursor.close();
        }
    }

    void remover(List<Pendente> enviados) {
        if (enviados.isEmpty()) {
            return;
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (Pendente evento : enviados) {
                db.delete(TABELA, "id = ?", new String[]{evento.id});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    void marcarTentativa(List<Pendente> lote) {
        if (lote.isEmpty()) {
            return;
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (Pendente evento : lote) {
                db.execSQL("UPDATE " + TABELA + " SET attempts = attempts + 1 WHERE id = ?",
                        new Object[]{evento.id});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Eventos que já falharam demais ou são antigos demais saem da fila:
     * a API corrige relógios muito atrasados para "agora", o que só
     * distorceria as séries.
     */
    void descartarVelhos(int maxTentativas, long maisAntigoQueMs) {
        getWritableDatabase().delete(TABELA,
                "attempts >= ? OR occurred_at < ?",
                new String[]{String.valueOf(maxTentativas), String.valueOf(maisAntigoQueMs)});
    }
}
