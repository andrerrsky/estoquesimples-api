package br.com.gameloop.estoquesimples;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MenuItem;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;

import com.google.android.material.textfield.TextInputLayout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.sync.AccountService;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.TeamClient;

/**
 * Quem tem acesso ao estoque da empresa.
 *
 * A lista mistura membros e convites pendentes de propósito: para quem
 * administra, um convite em aberto é acesso concedido esperando ser usado, e
 * separá-lo em outra aba faria convites esquecidos passarem despercebidos.
 */
public final class TeamActivity extends BaseActivity {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private final List<TeamClient.Member> membros = new ArrayList<>();
    private final List<TeamClient.Invite> convites = new ArrayList<>();

    private TeamClient client;
    private AccountService accounts;
    private SessionManager session;
    private ListView listView;
    private ProgressBar progress;
    private TextView messageView;
    private TextView verifyEmailNotice;
    private ArrayAdapter<String> adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_team);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Equipe");
        }

        session = SessionManager.get(this);
        client = new TeamClient(this);
        accounts = new AccountService(this);

        listView = findViewById(R.id.teamList);
        progress = findViewById(R.id.progress);
        messageView = findViewById(R.id.messageView);
        verifyEmailNotice = findViewById(R.id.verifyEmailNotice);

        Button convidar = findViewById(R.id.inviteButton);
        convidar.setOnClickListener(v -> promptConvite());
        verifyEmailNotice.setOnClickListener(v ->
                EmailVerificationUi.prompt(this, accounts, executor, main, this::atualizarAvisoDeEmail));

        adapter = new ArrayAdapter<>(this, R.layout.item_simple_text, new ArrayList<>());
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> abrirAcoes(position));

        carregar();
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    // -------------------------------------------------------------------------
    // Carga
    // -------------------------------------------------------------------------

    private void carregar() {
        setBusy(true);
        executor.execute(() -> {
            try {
                try {
                    accounts.refreshProfile();
                } catch (ApiException ignored) {
                    // A lista da equipe ainda pode ser mostrada; a confirmação
                    // de e-mail é exigida de novo na hora do convite.
                }
                List<TeamClient.Member> lista = client.members();
                List<TeamClient.Invite> pendentes = new ArrayList<>();
                for (TeamClient.Invite convite : client.invites()) {
                    if (convite.isPendente()) {
                        pendentes.add(convite);
                    }
                }
                main.post(() -> {
                    setBusy(false);
                    mostrar(lista, pendentes);
                });
            } catch (ApiException e) {
                main.post(() -> {
                    setBusy(false);
                    showMessage(e.userMessage());
                });
            }
        });
    }

    private void mostrar(List<TeamClient.Member> lista, List<TeamClient.Invite> pendentes) {
        showMessage(null);
        membros.clear();
        membros.addAll(lista);
        convites.clear();
        convites.addAll(pendentes);

        adapter.clear();
        for (TeamClient.Member membro : membros) {
            String linha = membro.name + "\n" + membro.email
                    + " · " + TeamClient.papelLegivel(membro.role);
            if (membro.isSuspenso()) {
                linha += " · acesso suspenso";
            }
            adapter.add(linha);
        }
        for (TeamClient.Invite convite : convites) {
            adapter.add("Convite pendente\n" + convite.email
                    + " · " + TeamClient.papelLegivel(convite.role));
        }
        adapter.notifyDataSetChanged();
        atualizarAvisoDeEmail();
    }

    private void atualizarAvisoDeEmail() {
        verifyEmailNotice.setVisibility(
                session.needsEmailVerification() ? View.VISIBLE : View.GONE);
    }

    // -------------------------------------------------------------------------
    // Convidar
    // -------------------------------------------------------------------------

    private void promptConvite() {
        if (session.needsEmailVerification()) {
            EmailVerificationUi.prompt(this, accounts, executor, main, () -> {
                atualizarAvisoDeEmail();
                promptConvite();
            });
            return;
        }

        LinearLayout caixa = new LinearLayout(this);
        caixa.setOrientation(LinearLayout.VERTICAL);
        int margem = (int) (20 * getResources().getDisplayMetrics().density);
        caixa.setPadding(margem, margem / 2, margem, 0);

        TextInputLayout emailLayout = FormValidation.addField(caixa, "E-mail de quem vai receber",
                android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);

        final int[] escolhido = { 2 };
        String[] rotulos = new String[TeamClient.PAPEIS.length];
        for (int i = 0; i < TeamClient.PAPEIS.length; i++) {
            rotulos[i] = TeamClient.papelLegivel(TeamClient.PAPEIS[i]);
        }

        Button papel = new Button(this);
        papel.setText("Papel: " + rotulos[escolhido[0]]);
        papel.setBackgroundResource(R.drawable.bg_button_secondary);
        papel.setTextColor(ContextCompat.getColor(this, R.color.color_brand));
        papel.setAllCaps(false);
        papel.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("Papel na empresa")
                .setItems(rotulos, (dialog, which) -> {
                    escolhido[0] = which;
                    papel.setText("Papel: " + rotulos[which]);
                })
                .show());
        caixa.addView(papel);

        TextView ajuda = new TextView(this);
        ajuda.setText("O que cada papel pode fazer?");
        ajuda.setTextColor(ContextCompat.getColor(this, R.color.color_brand));
        ajuda.setTextSize(14);
        ajuda.setPadding(0, (int) (8 * getResources().getDisplayMetrics().density), 0, 0);
        ajuda.setPaintFlags(ajuda.getPaintFlags() | android.graphics.Paint.UNDERLINE_TEXT_FLAG);
        ajuda.setOnClickListener(v -> mostrarAjudaPapeis());
        caixa.addView(ajuda);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Convidar pessoa")
                .setMessage("Ela recebe um código por e-mail, cria a própria senha e "
                        + "passa a ver o estoque desta empresa.")
                .setView(caixa)
                .setNegativeButton("Cancelar", null)
                // Listener sobrescrito depois do show(): assim o clique não fecha
                // o diálogo sozinho quando o e-mail está vazio.
                .setPositiveButton("Enviar convite", null)
                .show();

        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (!FormValidation.required(emailLayout, "Informe o e-mail de quem você quer convidar.")) {
                return;
            }
            String destino = emailLayout.getEditText().getText().toString().trim();
            dialog.dismiss();
            convidar(destino, TeamClient.PAPEIS[escolhido[0]]);
        });
    }

    private void mostrarAjudaPapeis() {
        new AlertDialog.Builder(this)
                .setTitle("Papéis na equipe")
                .setMessage(TeamClient.textoAjudaPapeis())
                .setPositiveButton("Entendi", null)
                .show();
    }

    private void convidar(String email, String papel) {
        setBusy(true);
        executor.execute(() -> {
            try {
                client.invite(email, papel);
                main.post(() -> {
                    Toast.makeText(this, "Convite enviado para " + email, Toast.LENGTH_LONG).show();
                    carregar();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    setBusy(false);
                    if (e.isEmailUnverified()) {
                        session.setEmailVerified(false);
                        atualizarAvisoDeEmail();
                        EmailVerificationUi.prompt(this, accounts, executor, main,
                                () -> convidar(email, papel));
                        return;
                    }
                    showMessage(e.userMessage());
                });
            }
        });
    }

    // -------------------------------------------------------------------------
    // Ações sobre um item
    // -------------------------------------------------------------------------

    private void abrirAcoes(int position) {
        if (position < membros.size()) {
            acoesDoMembro(membros.get(position));
            return;
        }
        int indice = position - membros.size();
        if (indice < convites.size()) {
            acoesDoConvite(convites.get(indice));
        }
    }

    private void acoesDoMembro(TeamClient.Member membro) {
        // O proprietário não aparece com ações porque nenhuma delas se aplica:
        // rebaixar ou remover quem é dono exige transferir a empresa antes.
        if ("proprietario".equals(membro.role)) {
            new AlertDialog.Builder(this)
                    .setTitle(membro.name)
                    .setMessage("Proprietário da empresa. Para mudar isso é preciso "
                            + "transferir a propriedade primeiro.")
                    .setPositiveButton("OK", null)
                    .show();
            return;
        }

        String suspender = membro.isSuspenso() ? "Reativar acesso" : "Suspender acesso";
        String[] opcoes = { "Alterar papel", suspender, "Remover da empresa" };

        new AlertDialog.Builder(this)
                .setTitle(membro.name + "\n" + membro.email)
                .setItems(opcoes, (dialog, which) -> {
                    if (which == 0) {
                        promptPapel(membro);
                    } else if (which == 1) {
                        confirmarSuspensao(membro);
                    } else {
                        confirmarRemocao(membro);
                    }
                })
                .show();
    }

    private void promptPapel(TeamClient.Member membro) {
        String[] rotulos = new String[TeamClient.PAPEIS.length];
        for (int i = 0; i < TeamClient.PAPEIS.length; i++) {
            rotulos[i] = TeamClient.papelLegivel(TeamClient.PAPEIS[i]);
        }

        new AlertDialog.Builder(this)
                .setTitle("Papel de " + membro.name)
                .setItems(rotulos, (dialog, which) -> executar(
                        () -> client.changeRole(membro.userId, TeamClient.PAPEIS[which]),
                        "Papel atualizado."))
                .show();
    }

    private void confirmarSuspensao(TeamClient.Member membro) {
        boolean suspender = !membro.isSuspenso();
        new AlertDialog.Builder(this)
                .setTitle(suspender ? "Suspender acesso" : "Reativar acesso")
                .setMessage(suspender
                        ? membro.name + " deixa de ver e alterar o estoque agora, "
                            + "mas continua na equipe e pode ser reativado."
                        : membro.name + " volta a ter acesso com o mesmo papel de antes.")
                .setNegativeButton("Voltar", null)
                .setPositiveButton(suspender ? "Suspender" : "Reativar",
                        (dialog, which) -> executar(
                                () -> client.setSuspended(membro.userId, suspender),
                                suspender ? "Acesso suspenso." : "Acesso reativado."))
                .show();
    }

    private void confirmarRemocao(TeamClient.Member membro) {
        new AlertDialog.Builder(this)
                .setTitle("Remover da empresa")
                .setMessage(membro.name + " perde o acesso imediatamente, em todos os "
                        + "aparelhos. O que essa pessoa registrou continua no histórico "
                        + "da empresa.")
                .setNegativeButton("Voltar", null)
                .setPositiveButton("Remover", (dialog, which) -> executar(
                        () -> client.remove(membro.userId),
                        "Pessoa removida da empresa."))
                .show();
    }

    private void acoesDoConvite(TeamClient.Invite convite) {
        new AlertDialog.Builder(this)
                .setTitle("Convite para " + convite.email)
                .setMessage("Papel oferecido: " + TeamClient.papelLegivel(convite.role)
                        + "\n\nEnviar de novo gera um código novo e invalida o anterior.")
                .setNeutralButton("Voltar", null)
                .setNegativeButton("Cancelar convite", (dialog, which) -> executar(
                        () -> client.cancelInvite(convite.id), "Convite cancelado."))
                .setPositiveButton("Enviar de novo", (dialog, which) ->
                        convidar(convite.email, convite.role))
                .show();
    }

    // -------------------------------------------------------------------------
    // Apoio
    // -------------------------------------------------------------------------

    /** Executa uma chamada de rede e recarrega a lista com o resultado real. */
    private void executar(Acao acao, String sucesso) {
        setBusy(true);
        executor.execute(() -> {
            try {
                acao.run();
                main.post(() -> {
                    Toast.makeText(this, sucesso, Toast.LENGTH_SHORT).show();
                    carregar();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    setBusy(false);
                    showMessage(e.userMessage());
                });
            }
        });
    }

    private interface Acao {
        void run() throws ApiException;
    }

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
    }

    private void showMessage(String mensagem) {
        if (mensagem == null) {
            messageView.setVisibility(View.GONE);
            return;
        }
        messageView.setText(mensagem);
        messageView.setVisibility(View.VISIBLE);
    }
}
