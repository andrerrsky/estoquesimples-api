package br.com.gameloop.estoquesimples;

import android.animation.ObjectAnimator;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.TooltipCompat;

import br.com.gameloop.estoquesimples.sync.EntitlementManager;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.SyncBootstrap;
import br.com.gameloop.estoquesimples.sync.SyncStatus;

/**
 * Ícone de sincronização na barra superior, ao lado do ⋮.
 *
 * Mostra em que pé a nuvem está sem a pessoa precisar abrir a tela de conta:
 * nuvem com check (tudo em dia), setas girando (sincronizando agora, seja por
 * toque ou pela rodada automática), nuvem com seta e um contador (alterações
 * feitas aqui que ainda não subiram) ou nuvem cortada (a última rodada falhou).
 * Um toque sincroniza na hora. Pressionar e segurar explica o estado.
 *
 * <p>Cada tela com menu ⋮ chama {@link #bind} ao criar o menu. O ícone escuta
 * {@link SyncStatus} enquanto está na tela e se desliga sozinho ao sair dela,
 * então as Activities não precisam cuidar do ciclo de vida.
 */
public final class SyncIndicator {

    private SyncIndicator() {
    }

    public static void bind(AppCompatActivity activity, Menu menu) {
        MenuItem item = menu.findItem(R.id.menu_sync);
        if (item == null) {
            return;
        }
        SessionManager session = SessionManager.get(activity);
        boolean comConta = session.isSignedIn() && session.workspaceId() != null;
        item.setVisible(comConta);
        View view = item.getActionView();
        if (!comConta || view == null) {
            return;
        }
        new Controller(activity, view).attach();
    }

    private static final class Controller implements SyncStatus.Listener,
            View.OnAttachStateChangeListener {

        private final AppCompatActivity activity;
        private final View root;
        private final ImageView icon;
        private final TextView badge;
        private ObjectAnimator giro;

        Controller(AppCompatActivity activity, View root) {
            this.activity = activity;
            this.root = root;
            this.icon = root.findViewById(R.id.syncIndicatorIcon);
            this.badge = root.findViewById(R.id.syncIndicatorBadge);
        }

        void attach() {
            root.setOnClickListener(v -> requestNow(activity));
            root.addOnAttachStateChangeListener(this);
            if (root.isAttachedToWindow()) {
                onViewAttachedToWindow(root);
            }
        }

        @Override
        public void onViewAttachedToWindow(View v) {
            SyncStatus.addListener(this);
            render(SyncStatus.current());
        }

        @Override
        public void onViewDetachedFromWindow(View v) {
            SyncStatus.removeListener(this);
            pararGiro();
        }

        @Override
        public void onSyncChanged(SyncStatus.Snapshot snapshot) {
            render(snapshot);
        }

        private void render(SyncStatus.Snapshot snapshot) {
            String descricao;
            if (snapshot.running) {
                icon.setImageResource(R.drawable.ic_sync);
                badge.setVisibility(View.GONE);
                iniciarGiro();
                descricao = "Sincronizando com a nuvem…";
            } else {
                pararGiro();
                if (snapshot.erro != null) {
                    icon.setImageResource(R.drawable.ic_cloud_off);
                    badge.setVisibility(View.GONE);
                    descricao = snapshot.erro + " Toque para tentar de novo.";
                } else if (snapshot.pendentes > 0) {
                    icon.setImageResource(R.drawable.ic_cloud_upload);
                    badge.setText(snapshot.pendentes > 99 ? "99+" : String.valueOf(snapshot.pendentes));
                    badge.setVisibility(View.VISIBLE);
                    descricao = (snapshot.pendentes == 1 ? "1 alteração aguardando envio."
                            : snapshot.pendentes + " alterações aguardando envio.")
                            + " Toque para sincronizar agora.";
                } else {
                    icon.setImageResource(R.drawable.ic_cloud_done);
                    badge.setVisibility(View.GONE);
                    descricao = "Tudo sincronizado. Toque para atualizar agora.";
                }
            }
            root.setContentDescription(descricao);
            TooltipCompat.setTooltipText(root, descricao);
        }

        private void iniciarGiro() {
            if (giro != null && giro.isRunning()) {
                return;
            }
            giro = ObjectAnimator.ofFloat(icon, View.ROTATION, 0f, 360f);
            giro.setDuration(1_100);
            giro.setInterpolator(new LinearInterpolator());
            giro.setRepeatCount(ObjectAnimator.INFINITE);
            giro.start();
        }

        private void pararGiro() {
            if (giro != null) {
                giro.cancel();
                giro = null;
            }
            icon.setRotation(0f);
        }
    }

    /**
     * Sincroniza agora, a pedido da pessoa (toque no ícone).
     *
     * Sem direito de sincronizar, a tela de conta explica o motivo; sem rede,
     * o aviso de conexão oferece tentar de novo. Com tudo certo, o bootstrap
     * reavalia o interruptor e dispara a rodada — e o resumo aparece ao fim,
     * porque a rodada foi marcada como pedida pela pessoa.
     */
    public static void requestNow(AppCompatActivity activity) {
        if (!new EntitlementManager(activity).canSync()) {
            activity.startActivity(new Intent(activity, AccountActivity.class));
            return;
        }
        if (!isOnline(activity)) {
            ConnectivityPrompt.show(activity, () -> requestNow(activity));
            return;
        }
        SyncStatus.markRequestedByUser();
        long pedidoEm = System.currentTimeMillis();
        SyncBootstrap.start(activity);
        // Rodada que não começa (o sistema segurou o trabalho): a pessoa fica
        // sabendo que ela sai sozinha depois, em vez de esperar à toa.
        activity.getWindow().getDecorView().postDelayed(() -> {
            SyncStatus.Snapshot agora = SyncStatus.current();
            if (!agora.running && agora.finishedAt < pedidoEm && !activity.isFinishing()) {
                Feedback.show(activity, "A sincronização vai rodar assim que o aparelho tiver conexão.");
            }
        }, 15_000);
    }

    private static boolean isOnline(AppCompatActivity activity) {
        ConnectivityManager manager =
                (ConnectivityManager) activity.getSystemService(AppCompatActivity.CONNECTIVITY_SERVICE);
        if (manager == null || manager.getActiveNetwork() == null) {
            return false;
        }
        NetworkCapabilities caps = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }
}
