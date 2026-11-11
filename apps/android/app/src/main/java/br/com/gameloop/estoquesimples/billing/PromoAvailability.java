package br.com.gameloop.estoquesimples.billing;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Se a oferta {@link PromoRules#TAG_BF2026} está disponível para esta conta
 * Google, com cache curto em SharedPreferences.
 *
 * A consulta abre uma conexão própria com a Play, em segundo plano, e a
 * encerra ao terminar: a tela inicial nunca espera por ela. Sem Play Store,
 * sem rede ou com erro do Billing, a resposta é "indisponível" (cartão fica
 * escondido) e o app segue como sempre. Guarda também quando o cartão foi
 * fechado.
 */
public final class PromoAvailability {

    private static final String TAG = "PromoAvailability";
    private static final String ARQUIVO = "promo_bf2026";
    private static final String CHAVE_CONSULTADO_EM = "checked_at";
    private static final String CHAVE_SUBTITULO = "subtitle";
    private static final String CHAVE_FECHADO_EM = "dismissed_at";

    /** Validade da resposta da Play (elegibilidade muda pouco; preço, quase nunca). */
    private static final long CACHE_MS = 30 * 60_000L;
    /** Tempo máximo esperando a loja antes de desistir desta rodada. */
    private static final long TIMEOUT_MS = 15_000L;

    private static final AtomicBoolean EM_ANDAMENTO = new AtomicBoolean(false);

    public interface Listener {
        /** Chamado na thread principal quando a consulta termina. */
        void onChecked();
    }

    private PromoAvailability() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
    }

    /** A última resposta ainda vale. */
    public static boolean isFresh(@NonNull Context context, long nowMillis) {
        long checkedAt = prefs(context).getLong(CHAVE_CONSULTADO_EM, 0L);
        return checkedAt > 0 && nowMillis - checkedAt >= 0 && nowMillis - checkedAt < CACHE_MS;
    }

    /** Subtítulo do cartão da última resposta; nulo = oferta indisponível. */
    @Nullable
    public static String cachedSubtitle(@NonNull Context context) {
        String value = prefs(context).getString(CHAVE_SUBTITULO, null);
        return value == null || value.isEmpty() ? null : value;
    }

    public static long dismissedAt(@NonNull Context context) {
        return prefs(context).getLong(CHAVE_FECHADO_EM, 0L);
    }

    public static void dismiss(@NonNull Context context, long nowMillis) {
        prefs(context).edit().putLong(CHAVE_FECHADO_EM, nowMillis).apply();
    }

    /** Depois de uma compra: a oferta deixa de valer para esta conta. */
    public static void invalidate(@NonNull Context context) {
        prefs(context).edit().remove(CHAVE_CONSULTADO_EM).remove(CHAVE_SUBTITULO).apply();
    }

    /** Consulta a Play em segundo plano; ignora se já houver uma consulta em andamento. */
    public static void refresh(@NonNull Context context, @NonNull Listener listener) {
        if (!EM_ANDAMENTO.compareAndSet(false, true)) {
            return;
        }
        final Context app = context.getApplicationContext();
        final Handler main = new Handler(Looper.getMainLooper());
        final PlayBilling billing = new PlayBilling(app);
        final AtomicBoolean terminou = new AtomicBoolean(false);

        final Runnable[] finish = new Runnable[1];
        final String[] subtitulo = new String[1];
        finish[0] = () -> {
            if (!terminou.compareAndSet(false, true)) {
                return;
            }
            main.removeCallbacksAndMessages(null);
            try {
                billing.endConnection();
            } catch (Exception ignored) {
                // Encerrar nunca derruba a tela.
            }
            prefs(app).edit()
                    .putLong(CHAVE_CONSULTADO_EM, System.currentTimeMillis())
                    .putString(CHAVE_SUBTITULO, subtitulo[0])
                    .apply();
            EM_ANDAMENTO.set(false);
            listener.onChecked();
        };

        main.postDelayed(finish[0], TIMEOUT_MS);
        try {
            billing.start(new PlayBilling.ConnectionListener() {
                @Override
                public void onReady() {
                    billing.queryOffer(PromoRules.TAG_BF2026, (offer, error) -> {
                        if (offer != null && offer.isPromo(PromoRules.TAG_BF2026)) {
                            subtitulo[0] = offer.promoSummary.cardSubtitle();
                        }
                        main.post(finish[0]);
                    });
                }

                @Override
                public void onError(String message) {
                    main.post(finish[0]);
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "loja indisponível para conferir a oferta", e);
            main.post(finish[0]);
        }
    }
}
