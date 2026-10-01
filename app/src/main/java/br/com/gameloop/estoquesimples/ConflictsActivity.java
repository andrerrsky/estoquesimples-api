package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.SyncMeta;
import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.ConflictsClient;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Decisões que só uma pessoa pode tomar.
 *
 * A tela existe porque a alternativa é pior. Quando dois aparelhos mudam o
 * preço do mesmo produto, escolher automaticamente significa que alguém vai
 * vender pelo valor errado sem nunca saber que sua alteração foi descartada.
 * Aqui os dois valores aparecem lado a lado e a escolha é explícita.
 */
public final class ConflictsActivity extends Activity {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<ConflictsClient.Conflict> conflitos = new ArrayList<>();

    private ConflictsClient client;
    private ListView listView;
    private TextView emptyView;
    private ProgressBar progress;
    private ArrayAdapter<String> adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_conflicts);
        setTitle("Conflitos");

        client = new ConflictsClient(new ApiClient(), SessionManager.get(this));

        listView = findViewById(R.id.conflictList);
        emptyView = findViewById(R.id.emptyView);
        progress = findViewById(R.id.progress);

        adapter = new ArrayAdapter<>(this, R.layout.item_simple_text, new ArrayList<>());
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> {
            if (position < conflitos.size()) {
                perguntar(conflitos.get(position));
            }
        });

        carregar();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void carregar() {
        setBusy(true);
        executor.execute(() -> {
            try {
                List<ConflictsClient.Conflict> pendentes = client.pending();
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    mostrar(pendentes);
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    if (!ConnectivityPrompt.report(this, e, this::carregar)) {
                        Toast.makeText(this, e.userMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                android.util.Log.e("ConflictsActivity", "falha ao carregar conflitos", e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    Toast.makeText(this, "Não foi possível falar com o servidor. Tente de novo.",
                            Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private void mostrar(List<ConflictsClient.Conflict> pendentes) {
        // A contagem que a tela de conta exibe vem daqui: esta é a informação
        // mais recente que o aparelho tem sobre o assunto.
        try {
            new SyncMeta(LocalDb.open(this))
                    .put(SyncMeta.CONFLITOS_PENDENTES, pendentes.size());
        } catch (Exception ignored) {
            // Só afeta o rótulo do botão na outra tela.
        }

        conflitos.clear();
        conflitos.addAll(pendentes);

        adapter.clear();
        for (ConflictsClient.Conflict conflito : pendentes) {
            adapter.add(descrever(conflito));
        }
        adapter.notifyDataSetChanged();

        boolean vazio = pendentes.isEmpty();
        emptyView.setVisibility(vazio ? View.VISIBLE : View.GONE);
        listView.setVisibility(vazio ? View.GONE : View.VISIBLE);
    }

    private String descrever(ConflictsClient.Conflict conflito) {
        if (conflito.isExclusao()) {
            return conflito.produto + "\nExcluído em outro aparelho enquanto era editado aqui.";
        }
        return conflito.produto + " — " + conflito.campoLegivel()
                + "\nNeste aparelho: " + conflito.valorLocal
                + "\nNa nuvem: " + conflito.valorNuvem;
    }

    private void perguntar(ConflictsClient.Conflict conflito) {
        if (conflito.isExclusao()) {
            new AlertDialog.Builder(this)
                    .setTitle(conflito.produto)
                    .setMessage("Este produto foi excluído em outro aparelho, mas havia uma "
                            + "edição pendente aqui. O histórico dele continua guardado nos "
                            + "dois casos.")
                    .setPositiveButton("Restaurar produto",
                            (dialog, which) -> resolver(conflito, ConflictsClient.ESCOLHA_RESTAURAR))
                    .setNegativeButton("Manter excluído",
                            (dialog, which) -> resolver(conflito, ConflictsClient.ESCOLHA_SERVIDOR))
                    .setNeutralButton("Decidir depois", null)
                    .show();
            return;
        }

        new AlertDialog.Builder(this)
                .setTitle(conflito.produto + " — " + conflito.campoLegivel())
                .setMessage("Neste aparelho: " + conflito.valorLocal
                        + "\nNa nuvem: " + conflito.valorNuvem)
                .setPositiveButton("Usar o deste aparelho",
                        (dialog, which) -> resolver(conflito, ConflictsClient.ESCOLHA_MINHA))
                .setNegativeButton("Usar o da nuvem",
                        (dialog, which) -> resolver(conflito, ConflictsClient.ESCOLHA_SERVIDOR))
                .setNeutralButton("Decidir depois", null)
                .show();
    }

    private void resolver(ConflictsClient.Conflict conflito, String escolha) {
        setBusy(true);
        executor.execute(() -> {
            try {
                client.resolve(conflito.id, escolha);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    Toast.makeText(this, "Decisão registrada.", Toast.LENGTH_SHORT).show();
                    // A lista é recarregada do servidor em vez de apenas
                    // remover o item: a decisão pode ter resolvido outros
                    // conflitos do mesmo produto.
                    carregar();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    if (!ConnectivityPrompt.report(this, e, () -> resolver(conflito, escolha))) {
                        Toast.makeText(this, e.userMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                android.util.Log.e("ConflictsActivity", "falha ao resolver conflito", e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    Toast.makeText(this, "Não foi possível falar com o servidor. Tente de novo.",
                            Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
    }
}
