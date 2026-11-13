package br.com.gameloop.estoquesimples;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.sync.RemoteConfig;

/**
 * Porta de entrada do app: confere se esta versão ainda pode ser usada antes
 * de abrir a tela inicial.
 *
 * <p><b>Por que existe.</b> Uma correção publicada na loja leva dias para
 * alcançar a base instalada, e quem não atualiza continua produzindo o mesmo
 * problema — no caso que motivou esta tela, saldos que não batiam entre o
 * aparelho e o site. Com esta porta, uma versão com defeito grave sai de
 * circulação no dia em que a substituta é aprovada: basta gravar
 * `minRequiredVersionCode` em `app_config`, sem publicar nada.
 *
 * <p><b>Regras que esta tela respeita.</b>
 * <ul>
 *   <li><b>Nunca bloqueia por conta própria.</b> O padrão é zero: sem uma
 *       resposta explícita do servidor dizendo que esta versão não serve mais,
 *       o app abre. Sem rede, com a API fora do ar ou com a resposta
 *       demorando, o app abre. Um aplicativo offline-first não pode ficar
 *       inútil porque o servidor não respondeu.</li>
 *   <li><b>Não pisca.</b> A tela fica no ar por pelo menos
 *       {@link #TEMPO_MINIMO_MS}, senão a abertura parece um defeito.</li>
 *   <li><b>Não trava.</b> A consulta tem {@link #TIMEOUT_MS} para responder; o
 *       que vier depois vale só para a próxima abertura.</li>
 *   <li><b>Decide pelo que já sabe.</b> O valor guardado da última consulta
 *       vale de imediato, então um aparelho bloqueado não ganha uma janela de
 *       uso enquanto a rede não responde.</li>
 * </ul>
 */
public final class SplashActivity extends AppCompatActivity {

    /** Tempo mínimo de tela, para a abertura não parecer um engasgo. */
    static final long TEMPO_MINIMO_MS = 900L;

    /** Depois disto, segue sem resposta: a verificação não pode travar o app. */
    static final long TIMEOUT_MS = 3_500L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private ExecutorService executor;
    private long inicio;
    private boolean decidido;
    /** A tela de atualização obrigatória está no ar. */
    private boolean bloqueado;
    /** O bloqueio já foi contado nesta abertura. */
    private boolean bloqueioContado;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // O app já está aberto e a pessoa tocou no ícone: o sistema entrega o
        // intent de lançamento aqui, não na raiz da tarefa (que passou a ser a
        // MainActivity quando esta tela se apagou). Seguir em frente criaria
        // uma segunda MainActivity por cima da primeira — duas telas iniciais
        // empilhadas, "voltar" que não sai do app e estado duplicado.
        if (!isTaskRoot()
                && Intent.ACTION_MAIN.equals(getIntent().getAction())
                && getIntent().hasCategory(Intent.CATEGORY_LAUNCHER)) {
            finish();
            return;
        }

        setContentView(R.layout.activity_splash);

        inicio = SystemClock.elapsedRealtime();
        revelarEspera();
        verificar();
    }

    /**
     * O spinner e o texto nascem visíveis; o fade é só um afago na entrada.
     *
     * Nada aqui pode depender de a animação rodar: com animações desligadas
     * (opção de desenvolvedor, economia de bateria, acessibilidade) um fade
     * que não acontece deixaria a tela em branco, e o cliente preso num app
     * que parece travado. Por isso o estado visível é o do XML, e a animação
     * só caminha de um ponto já visível para outro.
     */
    private void revelarEspera() {
        View spinner = findViewById(R.id.splashSpinner);
        View status = findViewById(R.id.splashStatus);
        spinner.setTranslationY(12f);
        status.setTranslationY(12f);
        spinner.animate().translationY(0f).setDuration(240L).start();
        status.animate().translationY(0f).setStartDelay(80L).setDuration(240L).start();
    }

    /**
     * @param escura ícones escuros, para fundo claro.
     */
    private void pintarBarraDeStatus(int corDeFundo, boolean escura) {
        getWindow().setStatusBarColor(androidx.core.content.ContextCompat.getColor(this, corDeFundo));
        getWindow().setNavigationBarColor(androidx.core.content.ContextCompat.getColor(this, corDeFundo));
        androidx.core.view.WindowInsetsControllerCompat controlador =
                androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controlador.setAppearanceLightStatusBars(escura);
        controlador.setAppearanceLightNavigationBars(escura);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (executor != null) {
            executor.shutdownNow();
        }
        super.onDestroy();
    }

    /**
     * Voltar da loja reavalia na hora: quem atualizou não precisa ficar preso
     * na tela, e quem só olhou a página continua bloqueado.
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (bloqueado) {
            verificarDeNovo();
        }
    }

    private void verificarDeNovo() {
        if (executor != null) {
            executor.shutdownNow();
        }
        handler.removeCallbacksAndMessages(null);
        decidido = false;
        bloqueado = false;
        // `bloqueioContado` não volta a falso: "verificar de novo" é a mesma
        // abertura, e contá-la de novo adiantaria a saída de emergência.
        inicio = SystemClock.elapsedRealtime();
        setContentView(R.layout.activity_splash);
        pintarBarraDeStatus(R.color.color_brand, false);
        revelarEspera();
        verificar();
    }

    private void verificar() {
        RemoteConfig config = new RemoteConfig(this);

        // O que já se sabe vale de imediato: se este aparelho já estava
        // bloqueado, não há motivo para esperar a rede para dizer isso. Mas
        // essa decisão não é final — ver `decidido` em agendarDecisao.
        if (config.isUpdateBlocking()) {
            agendarDecisao(() -> mostrarBloqueio(config), false);
        }

        executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            try {
                config.refresh();
            } catch (RuntimeException e) {
                // Config indisponível é caso normal: segue com o último valor.
            }
            handler.post(() -> agendarDecisao(decisaoFinal(config), true));
        });

        // Rede lenta não prende ninguém: passado o teto, decide com o que há.
        handler.postDelayed(() -> agendarDecisao(decisaoFinal(config), true), TIMEOUT_MS);
    }

    /** O que fazer depois de ouvir o servidor. */
    private Runnable decisaoFinal(RemoteConfig config) {
        return () -> {
            if (config.isUpdateBlocking()) {
                mostrarBloqueio(config);
            } else {
                abrirApp();
            }
        };
    }

    /**
     * Garante o tempo mínimo de tela e que só uma decisão valha.
     *
     * @param ouviuOServidor a decisão veio da resposta (ou do fim da espera
     *     por ela). Só essa é final: um bloqueio decidido pelo valor guardado
     *     precisa poder ser desfeito quando o servidor disser que não é mais
     *     necessário — senão um valor errado publicado por engano deixaria os
     *     aparelhos que o pegaram travados até alguém descobrir o botão de
     *     verificar de novo.
     */
    private void agendarDecisao(Runnable decisao, boolean ouviuOServidor) {
        if (decidido || isFinishing() || isDestroyed()) {
            return;
        }
        decidido = ouviuOServidor;
        long restante = Math.max(0L, TEMPO_MINIMO_MS - (SystemClock.elapsedRealtime() - inicio));
        handler.postDelayed(() -> {
            if (!isFinishing() && !isDestroyed()) {
                decisao.run();
            }
        }, restante);
    }

    /**
     * Troca a tela inteira pela de atualização obrigatória.
     *
     * É um `setContentView` e não um estado escondido do mesmo layout: esta é
     * a única saída que o cliente tem, e não pode depender de uma troca de
     * visibilidade ou de uma animação para aparecer.
     */
    private void mostrarBloqueio(RemoteConfig config) {
        setContentView(R.layout.activity_update_required);
        // Esta tela é clara: sem inverter a barra de status, a hora e os
        // ícones do sistema ficam brancos sobre branco.
        pintarBarraDeStatus(R.color.color_surface, true);
        findViewById(R.id.splashUpdateButton).setOnClickListener(v -> abrirLoja());
        findViewById(R.id.splashRetryButton).setOnClickListener(v -> verificarDeNovo());
        bloqueado = true;

        // Quem já viu esta tela algumas vezes e continua aqui provavelmente
        // não consegue atualizar. O estoque está neste aparelho e é dele: a
        // saída tem que existir, mesmo que custe um dia a mais de versão
        // antiga em circulação.
        // Contado uma vez por abertura: a tela pode ser montada duas vezes na
        // mesma — primeiro pelo valor guardado, depois pela resposta do
        // servidor —, e contar as duas adiantaria a saída de emergência.
        boolean cabeOferecer = bloqueioContado
                ? config.blockShownCount() >= RemoteConfig.BLOQUEIOS_ATE_A_SAIDA
                : config.registerBlockShown();
        bloqueioContado = true;

        View saida = findViewById(R.id.splashSkipButton);
        if (cabeOferecer) {
            saida.setVisibility(View.VISIBLE);
            saida.setOnClickListener(v -> {
                config.grantGrace();
                Toast.makeText(this, R.string.splash_update_skip_granted, Toast.LENGTH_LONG).show();
                abrirApp();
            });
        }

        String recado = config.updateMessage();
        if (recado != null) {
            ((TextView) findViewById(R.id.splashUpdateMessage)).setText(recado);
        }
    }

    private void abrirApp() {
        Intent intent = new Intent(this, MainActivity.class);
        // Repassa o que trouxe o app para cá (atalho, notificação, link), para
        // que esta tela seja invisível no caminho.
        Intent origem = getIntent();
        if (origem != null) {
            if (origem.getExtras() != null) {
                intent.putExtras(origem.getExtras());
            }
            if (origem.getData() != null) {
                intent.setData(origem.getData());
            }
        }
        // A tela inicial é o fim da linha: nada do que veio antes fica na pilha.
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        // Sem animação de saída: a tela inicial deve parecer a continuação
        // desta, não uma segunda abertura.
        overridePendingTransition(0, 0);
        finish();
    }

    private void abrirLoja() {
        String url = new RemoteConfig(this).updateUrl();
        try {
            // Tenta a Play Store instalada antes do navegador.
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .setPackage("com.android.vending")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException semPlay) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException semNavegador) {
                Toast.makeText(this, R.string.splash_update_store_missing, Toast.LENGTH_LONG).show();
            }
        }
    }
}
