package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.util.Log;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.SyncMeta;

/** A faixa "Sincronização pausada" da tela inicial (bloqueio pelo plano). */
public final class SyncBlock {

    private static final String TAG = "SyncBlock";

    private SyncBlock() {
    }

    /**
     * Apaga o aviso de bloqueio pelo plano. Chamado quando a assinatura é
     * confirmada e quando o servidor responde com outro problema que não o
     * plano; a tela inicial relê o valor ao voltar para ela.
     */
    public static void clearPlanBlock(Context context) {
        try {
            new SyncMeta(LocalDb.open(context)).remove(SyncMeta.BLOQUEIO_PLANO);
        } catch (Exception e) {
            Log.w(TAG, "não foi possível limpar o aviso de bloqueio do plano", e);
        }
    }
}
