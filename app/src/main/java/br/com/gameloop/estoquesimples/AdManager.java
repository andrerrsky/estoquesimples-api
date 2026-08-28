package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.appodeal.ads.Appodeal;

/**
 * Gerenciador de anúncios e contagem de interações.
 *
 * Interstitials, banners e MREC continuam para quem não tem premium.
 * O desbloqueio temporário de recursos por rewarded video foi removido.
 */
public class AdManager {

    private static final String TAG = "AdManager";
    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_INTERACTION_COUNT = "interactionCount";
    private static final int INTERACTIONS_UNTIL_INTERSTITIAL = 8;

    private SharedPreferences prefs;
    private Context context;
    private static AdManager instance;
    private PremiumManager premiumManager;

    private AdManager(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.premiumManager = PremiumManager.getInstance(context);
    }

    public static synchronized AdManager getInstance(Context context) {
        if (instance == null) {
            instance = new AdManager(context);
        }
        return instance;
    }

    /**
     * Registra uma interação do usuário.
     * Deve ser chamado em ações importantes como adicionar produto, editar, exportar, etc.
     */
    public void registerInteraction(Activity activity) {
        if (premiumManager.hasPremiumAccess()) {
            return;
        }

        int count = prefs.getInt(KEY_INTERACTION_COUNT, 0);
        count++;
        prefs.edit().putInt(KEY_INTERACTION_COUNT, count).apply();

        Log.d(TAG, "Interaction registered: " + count);

        if (count >= INTERACTIONS_UNTIL_INTERSTITIAL) {
            showInterstitial(activity);
        }
    }

    /**
     * Mostra um anúncio interstitial e reseta o contador.
     */
    private void showInterstitial(Activity activity) {
        if (activity == null || activity.isFinishing()) {
            return;
        }

        resetInteractionCount();

        if (Appodeal.canShow(Appodeal.INTERSTITIAL)) {
            Appodeal.show(activity, Appodeal.INTERSTITIAL);
        } else {
            Log.d(TAG, "Interstitial not loaded yet");
        }
    }

    /**
     * Reseta o contador de interações.
     */
    private void resetInteractionCount() {
        prefs.edit().putInt(KEY_INTERACTION_COUNT, 0).apply();
        Log.d(TAG, "Interaction count reset");
    }

    /**
     * Mostra banners e MREC se o usuário não tiver premium.
     * Deferred via View.post() to avoid blocking the UI thread during
     * onCreate, reducing ANR risk from ad SDK NumberFormat allocations.
     */
    public void showBannerAds(Activity activity, int bannerViewId, int mrecViewId) {
        if (premiumManager.hasPremiumAccess()) {
            hideBannerAds(activity, bannerViewId, mrecViewId);
            return;
        }

        android.view.View decorView = activity.getWindow().getDecorView();
        decorView.post(() -> {
            if (activity.isFinishing()) return;
            if (MainActivity.instance != null && MainActivity.instance.isAppODealInitialized()) {
                if (bannerViewId != 0) {
                    android.view.View bannerView = activity.findViewById(bannerViewId);
                    if (bannerView != null && bannerView.getParent() instanceof android.view.View) {
                        ((android.view.View) bannerView.getParent()).setVisibility(android.view.View.VISIBLE);
                    }
                    Appodeal.setBannerViewId(bannerViewId);
                    Appodeal.show(activity, Appodeal.BANNER_VIEW);
                }
                if (mrecViewId != 0) {
                    Appodeal.setMrecViewId(mrecViewId);
                    Appodeal.show(activity, Appodeal.MREC);
                }
            }
        });
    }

    /**
     * Esconde banners e MREC.
     */
    public void hideBannerAds(Activity activity, int bannerViewId, int mrecViewId) {
        if (bannerViewId != 0) {
            android.view.View bannerView = activity.findViewById(bannerViewId);
            if (bannerView != null && bannerView.getParent() != null) {
                ((android.view.ViewGroup) bannerView.getParent()).setVisibility(android.view.View.GONE);
            }
        }
        if (mrecViewId != 0) {
            android.view.View mrecView = activity.findViewById(mrecViewId);
            if (mrecView != null && mrecView.getParent() != null) {
                ((android.view.ViewGroup) mrecView.getParent()).setVisibility(android.view.View.GONE);
            }
        }
        Appodeal.hide(activity, Appodeal.BANNER_VIEW);
        Appodeal.hide(activity, Appodeal.MREC);
    }
}
