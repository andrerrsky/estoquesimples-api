package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.appcompat.app.AlertDialog;

import com.appodeal.ads.Appodeal;
import com.appodeal.ads.RewardedVideoCallbacks;

/**
 * Gerenciador de anúncios e contagem de interações
 * Controla quando mostrar interstitials e rewarded videos
 */
public class AdManager {
    
    private static final String TAG = "AdManager";
    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_INTERACTION_COUNT = "interactionCount";
    private static final int INTERACTIONS_UNTIL_INTERSTITIAL = 8; // Exibir interstitial a cada 8 interações
    
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
     * Registra uma interação do usuário
     * Deve ser chamado em ações importantes como adicionar produto, editar, exportar, etc.
     */
    public void registerInteraction(Activity activity) {
        // Se o usuário tem premium, não contar interações
        if (premiumManager.hasPremiumAccess()) {
            return;
        }
        
        int count = prefs.getInt(KEY_INTERACTION_COUNT, 0);
        count++;
        prefs.edit().putInt(KEY_INTERACTION_COUNT, count).apply();
        
        Log.d(TAG, "Interaction registered: " + count);
        
        // Verificar se deve mostrar interstitial
        if (count >= INTERACTIONS_UNTIL_INTERSTITIAL) {
            showInterstitialDialog(activity);
        }
    }
    
    /**
     * Mostra o dialog oferecendo premium de 1 hora antes do interstitial
     */
    private void showInterstitialDialog(final Activity activity) {
        if (activity == null || activity.isFinishing()) {
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 17 && activity.isDestroyed()) {
            return;
        }
        
        activity.runOnUiThread(() -> {
            if (activity.isFinishing()) {
                return;
            }
            if (android.os.Build.VERSION.SDK_INT >= 17 && activity.isDestroyed()) {
                return;
            }
            AlertDialog.Builder builder = new AlertDialog.Builder(activity);
            builder.setTitle("Aproveite sem Anúncios!");
            builder.setMessage("Você pode:\n\n" +
                    "• Assistir um vídeo curto e desbloquear 1 HORA de versão PRO sem anúncios\n" +
                    "• Ou continuar e ver um anúncio rápido agora");
            builder.setCancelable(false);
            
            // Botão para assistir rewarded video
            builder.setPositiveButton("🎬 1 Hora Grátis", (dialog, which) -> {
                dialog.dismiss();
                showRewardedVideo(activity);
            });
            
            // Botão para continuar com interstitial
            builder.setNegativeButton("Continuar", (dialog, which) -> {
                dialog.dismiss();
                showInterstitial(activity);
            });
            
            builder.show();
        });
    }
    
    /**
     * Mostra um anúncio rewarded video diretamente (público para uso no card de premium)
     */
    public void showRewardedVideoForPremium(final Activity activity) {
        showRewardedVideo(activity);
    }
    
    /**
     * Mostra um anúncio rewarded video
     */
    private void showRewardedVideo(final Activity activity) {
        if (activity == null || activity.isFinishing()) {
            return;
        }
        
        // Configurar callback para rewarded video
        Appodeal.setRewardedVideoCallbacks(new RewardedVideoCallbacks() {
            @Override
            public void onRewardedVideoLoaded(boolean isPrecache) {
                Log.d(TAG, "Rewarded video loaded");
            }
            
            @Override
            public void onRewardedVideoFailedToLoad() {
                Log.d(TAG, "Rewarded video failed to load");
                activity.runOnUiThread(() -> {
                    new AlertDialog.Builder(activity)
                        .setTitle("Ops!")
                        .setMessage("Não foi possível carregar o vídeo no momento. Tente novamente mais tarde.")
                        .setPositiveButton("OK", null)
                        .show();
                });
            }
            
            @Override
            public void onRewardedVideoShown() {
                Log.d(TAG, "Rewarded video shown");
            }
            
            @Override
            public void onRewardedVideoShowFailed() {
                Log.d(TAG, "Rewarded video show failed");
            }
            
            @Override
            public void onRewardedVideoFinished(double amount, String name) {
                Log.d(TAG, "Rewarded video finished - reward earned!");
                // Ativar modo premium por 1 hora
                premiumManager.activateTempPremium();
                resetInteractionCount();
                
                activity.runOnUiThread(() -> {
                    new AlertDialog.Builder(activity)
                        .setTitle("🎉 Parabéns!")
                        .setMessage("Você desbloqueou 1 HORA SEM ANÚNCIOS!\n\nAproveite a experiência premium!")
                        .setPositiveButton("Ótimo!", null)
                        .show();
                    
                    // Atualizar a UI se for MainActivity
                    if (activity instanceof MainActivity) {
                        ((MainActivity) activity).updatePremiumCard();
                    }
                });
            }
            
            @Override
            public void onRewardedVideoClosed(boolean finished) {
                Log.d(TAG, "Rewarded video closed. Finished: " + finished);
                if (!finished) {
                    // Usuário fechou antes de terminar
                    activity.runOnUiThread(() -> {
                        new AlertDialog.Builder(activity)
                            .setMessage("Você precisa assistir o vídeo completo para ganhar 1 hora sem anúncios.")
                            .setPositiveButton("OK", null)
                            .show();
                    });
                }
            }
            
            @Override
            public void onRewardedVideoExpired() {
                Log.d(TAG, "Rewarded video expired");
            }
            
            @Override
            public void onRewardedVideoClicked() {
                Log.d(TAG, "Rewarded video clicked");
            }
        });
        
        // Tentar mostrar o rewarded video
        if (Appodeal.canShow(Appodeal.REWARDED_VIDEO)) {
            Appodeal.show(activity, Appodeal.REWARDED_VIDEO);
        } else {
            // Não está carregado, mostrar mensagem
            activity.runOnUiThread(() -> {
                new AlertDialog.Builder(activity)
                    .setTitle("Carregando...")
                    .setMessage("O vídeo ainda está carregando. Tente novamente em alguns segundos.")
                    .setPositiveButton("OK", null)
                    .show();
            });
        }
    }
    
    /**
     * Mostra um anúncio interstitial e reseta o contador
     */
    private void showInterstitial(Activity activity) {
        if (activity == null || activity.isFinishing()) {
            return;
        }
        
        // Resetar contador
        resetInteractionCount();
        
        // Mostrar interstitial se disponível
        if (Appodeal.canShow(Appodeal.INTERSTITIAL)) {
            Appodeal.show(activity, Appodeal.INTERSTITIAL);
        } else {
            Log.d(TAG, "Interstitial not loaded yet");
        }
    }
    
    /**
     * Reseta o contador de interações
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
     * Esconde banners e MREC
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

