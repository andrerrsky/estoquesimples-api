package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.data.LocalDb;

/**
 * Pede a avaliação na Google Play, dentro do app, uma única vez e só para
 * quem já usa de verdade: instalado há pelo menos {@link #MIN_DAYS} dias e com
 * {@link #MIN_MOVEMENTS} movimentações registradas (entrada, saída ou ajuste).
 *
 * É a janela da própria Play (In-App Review): a loja decide se mostra ou não
 * e não diz o que a pessoa escolheu, então nada aqui depende do resultado.
 * Avaliações de quem já ativou ajudam o app a subir na busca da loja.
 */
public final class ReviewPrompt {

    static final int MIN_DAYS = 3;
    static final int MIN_MOVEMENTS = 10;

    private static final String PREFS = "review_prompt";
    private static final String KEY_ASKED = "asked";

    private static volatile boolean checking;

    private ReviewPrompt() {}

    /** Chamado ao voltar para a tela inicial. Não faz nada na maioria das vezes. */
    public static void maybeAsk(final Activity activity) {
        final Context app = activity.getApplicationContext();
        final SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(KEY_ASKED, false) || checking || !installedLongEnough(app)) {
            return;
        }
        checking = true;
        new Thread(() -> {
            try {
                if (countMovements(app) < MIN_MOVEMENTS) {
                    return;
                }
                activity.runOnUiThread(() -> launch(activity, prefs));
            } catch (RuntimeException ignored) {
                // Banco indisponível agora: tenta na próxima vez.
            } finally {
                checking = false;
            }
        }, "review-prompt").start();
    }

    static boolean eligible(long installedAtMs, long nowMs, int movements) {
        return nowMs - installedAtMs >= MIN_DAYS * 24L * 3_600_000L && movements >= MIN_MOVEMENTS;
    }

    private static boolean installedLongEnough(Context context) {
        try {
            long installedAt = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).firstInstallTime;
            return eligible(installedAt, System.currentTimeMillis(), MIN_MOVEMENTS);
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private static int countMovements(Context context) {
        SQLiteDatabase db = LocalDb.open(context);
        try (Cursor cursor = db.rawQuery(
                "SELECT COUNT(*) FROM " + LocalDb.TABLE_MOVEMENTS
                        + " WHERE change_type IN ('entrada', 'saida', 'ajuste', 'venda', 'compra')",
                null)) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    private static void launch(Activity activity, SharedPreferences prefs) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            return;
        }
        // Marca antes de pedir: a Play limita quantas vezes a janela aparece e
        // não queremos insistir com quem fechou.
        prefs.edit().putBoolean(KEY_ASKED, true).apply();
        try {
            ReviewManager manager = ReviewManagerFactory.create(activity);
            manager.requestReviewFlow().addOnCompleteListener(request -> {
                if (!request.isSuccessful() || activity.isFinishing() || activity.isDestroyed()) {
                    return;
                }
                ReviewInfo info = request.getResult();
                manager.launchReviewFlow(activity, info);
                Analytics.track(activity, "review.prompted");
            });
        } catch (RuntimeException ignored) {
            // Sem Play Store no aparelho.
        }
    }
}
