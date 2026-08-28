package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.data.Diagnostics;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.data.SyncMeta;
import br.com.gameloop.estoquesimples.billing.PendingPurchase;
import br.com.gameloop.estoquesimples.sync.AccountService;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.EntitlementManager;
import br.com.gameloop.estoquesimples.sync.PasswordPolicy;
import br.com.gameloop.estoquesimples.sync.RemoteConfig;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.SyncBootstrap;
import br.com.gameloop.estoquesimples.sync.SyncScheduler;
import br.com.gameloop.estoquesimples.sync.TeamClient;

/**
 * Conta e estado da sincronização.
 *
 * Toda operação de rede sai da thread principal e volta pelo handler. A tela é
 * escrita para ser honesta sobre o que está acontecendo: se algo não pode ser
 * sincronizado, o motivo aparece aqui, junto com a garantia de que os dados
 * continuam no aparelho.
 */
public class AccountActivity extends BaseActivity {

    private static final String TAG = "AccountActivity";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private LinearLayout signedInSection;
    private LinearLayout signedOutSection;
    private TextView accountEmail;
    private TextView accountWorkspace;
    private TextView syncStatus;
    private TextView messageView;
    private ProgressBar progress;
    private View nameLayout;
    private EditText nameField;
    private EditText emailField;
    private EditText passwordField;
    private View passwordRules;
    private TextView ruleLength;
    private TextView ruleCommon;
    private TextView ruleRepeated;
    private TextView ruleEmail;
    private Button primaryButton;
    private Button toggleModeButton;
    private TextView legalNotice;

    private SessionManager session;
    private AccountService accounts;

    /** Cadastro exige nome; entrada, não. */
    private boolean registerMode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_account);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Conta e sincronização");
        }

        session = SessionManager.get(this);
        accounts = new AccountService(this);

        bindViews();
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        refreshEntitlementIfSignedIn();
    }

    private void bindViews() {
        signedInSection = findViewById(R.id.signedInSection);
        signedOutSection = findViewById(R.id.signedOutSection);
        accountEmail = findViewById(R.id.accountEmail);
        accountWorkspace = findViewById(R.id.accountWorkspace);
        syncStatus = findViewById(R.id.syncStatus);
        messageView = findViewById(R.id.messageView);
        progress = findViewById(R.id.progress);
        nameLayout = findViewById(R.id.nameLayout);
        nameField = findViewById(R.id.nameField);
        emailField = findViewById(R.id.emailField);
        passwordField = findViewById(R.id.passwordField);
        passwordRules = findViewById(R.id.passwordRules);
        ruleLength = findViewById(R.id.ruleLength);
        ruleCommon = findViewById(R.id.ruleCommon);
        ruleRepeated = findViewById(R.id.ruleRepeated);
        ruleEmail = findViewById(R.id.ruleEmail);
        primaryButton = findViewById(R.id.primaryButton);
        toggleModeButton = findViewById(R.id.toggleModeButton);
        legalNotice = findViewById(R.id.legalNotice);
        LegalDocuments.bindCadastroNotice(legalNotice);

        primaryButton.setOnClickListener(v -> submitCredentials());
        toggleModeButton.setOnClickListener(v -> toggleMode());
        TextWatcher regrasAoDigitar = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                refreshPasswordRules();
            }
        };
        passwordField.addTextChangedListener(regrasAoDigitar);
        emailField.addTextChangedListener(regrasAoDigitar);

        findViewById(R.id.syncNowButton).setOnClickListener(v -> syncNow());
        findViewById(R.id.conflictsButton).setOnClickListener(v ->
                startActivity(new Intent(this, ConflictsActivity.class)));
        findViewById(R.id.teamButton).setOnClickListener(v ->
                startActivity(new Intent(this, TeamActivity.class)));
        findViewById(R.id.subscriptionButton).setOnClickListener(v ->
                SubscriptionActivity.open(this));
        findViewById(R.id.inviteCodeButton).setOnClickListener(v -> promptInviteCode());
        findViewById(R.id.diagnosticsButton).setOnClickListener(v -> showDiagnostics());
        findViewById(R.id.logoutButton).setOnClickListener(v -> confirmLogout());
        findViewById(R.id.verifyEmailButton).setOnClickListener(v ->
                EmailVerificationUi.prompt(this, accounts, executor, main, this::render));
    }

    // -------------------------------------------------------------------------
    // Estado da tela
    // -------------------------------------------------------------------------

    private void render() {
        boolean signedIn = session.isSignedIn();
        signedInSection.setVisibility(signedIn ? View.VISIBLE : View.GONE);
        signedOutSection.setVisibility(signedIn ? View.GONE : View.VISIBLE);

        if (signedIn) {
            accountEmail.setText(session.userEmail());
            String workspace = session.workspaceName();
            accountWorkspace.setText(workspace != null
                    ? workspace + " · " + session.role()
                    : "Nenhuma empresa selecionada");
            syncStatus.setText(buildStatusText());

            // O botão só aparece quando há decisão a tomar. Um botão sempre
            // presente convida a abrir uma tela vazia e ensina a ignorá-lo,
            // justo o oposto do que se quer quando um conflito surgir.
            long pendentes = new SyncMeta(LocalDb.open(this))
                    .getLong(SyncMeta.CONFLITOS_PENDENTES, 0L);
            Button conflitos = findViewById(R.id.conflictsButton);
            conflitos.setVisibility(pendentes > 0 ? View.VISIBLE : View.GONE);
            conflitos.setText(pendentes == 1
                    ? "Resolver 1 conflito"
                    : "Resolver " + pendentes + " conflitos");

            // Sem empresa escolhida não há equipe nem assinatura para gerenciar.
            boolean temEmpresa = session.workspaceId() != null;
            findViewById(R.id.teamButton).setVisibility(temEmpresa ? View.VISIBLE : View.GONE);
            findViewById(R.id.subscriptionButton).setVisibility(
                    temEmpresa ? View.VISIBLE : View.GONE);
            findViewById(R.id.verifyEmailButton).setVisibility(
                    session.needsEmailVerification() ? View.VISIBLE : View.GONE);
            if (!session.isEmailVerified()) {
                refreshEmailStatus();
            }
        }
    }

    private void refreshEmailStatus() {
        executor.execute(() -> {
            try {
                accounts.refreshProfile();
                main.post(() -> {
                    if (isFinishing() || !session.isSignedIn()) {
                        return;
                    }
                    findViewById(R.id.verifyEmailButton).setVisibility(
                            session.needsEmailVerification() ? View.VISIBLE : View.GONE);
                });
            } catch (ApiException ignored) {
                // Sem o perfil a tela continua útil; o convite confirma no servidor.
            }
        });
    }

    /**
     * Atualiza o retrato da assinatura ao abrir a tela.
     *
     * Sem isso, quem nunca abriu Assinatura ficava com o cache vazio e o botão
     * de sincronizar fingia ter funcionado: o worker nem chegava a rodar.
     */
    private void refreshEntitlementIfSignedIn() {
        if (!session.isSignedIn() || session.workspaceId() == null) {
            return;
        }
        executor.execute(() -> {
            try {
                new EntitlementManager(this).refresh();
                main.post(() -> {
                    if (isFinishing() || !session.isSignedIn()) {
                        return;
                    }
                    render();
                });
            } catch (ApiException ignored) {
                // O retrato local continua na tela; a próxima tentativa atualiza.
            }
        });
    }

    /**
     * Resumo do que está acontecendo com a sincronização.
     *
     * Inclui o número de operações na fila porque é a informação que responde à
     * pergunta que o usuário realmente faz — "o que eu fiz já subiu?".
     */
    private String buildStatusText() {
        StringBuilder texto = new StringBuilder();

        RemoteConfig config = new RemoteConfig(this);
        if (!config.isSyncEnabled()) {
            texto.append("A sincronização está temporariamente desativada. ")
                    .append("O app continua funcionando normalmente neste aparelho.\n\n");
        } else if (!config.isProtocolSupported()) {
            texto.append("Atualize o app pela Play Store para voltar a sincronizar.\n\n");
        }

        EntitlementManager entitlements = new EntitlementManager(this);
        if (entitlements.isStale()) {
            texto.append("Não foi possível confirmar a assinatura recentemente.\n");
        } else if (!entitlements.canSync()) {
            texto.append(entitlements.stateLegivel()).append("\n");
            if (PremiumManager.getInstance(this).isPro()) {
                texto.append("A antiga Versão PRO continua válida neste aparelho ")
                        .append("(recursos premium e sem anúncios). A nuvem exige assinatura.\n");
            }
            texto.append("Abra Assinatura para liberar a sincronização na nuvem.\n");
        } else {
            texto.append(entitlements.stateLegivel()).append("\n");
        }

        try {
            SyncMeta meta = new SyncMeta(LocalDb.open(this));
            long ultima = meta.getLong(SyncMeta.ULTIMA_SINCRONIZACAO, 0L);
            texto.append("Última sincronização: ")
                    .append(ultima > 0 ? formatDate(ultima) : "ainda não sincronizado")
                    .append("\n");

            OutboxRepository outbox = new OutboxRepository(LocalDb.open(this));
            int pendentes = outbox.pendingCount();
            int falhas = outbox.failedCount();

            texto.append("Aguardando envio: ").append(pendentes)
                    .append(pendentes == 1 ? " alteração" : " alterações");
            if (falhas > 0) {
                texto.append("\nCom erro: ").append(falhas)
                        .append(" — nada foi descartado, os dados seguem no aparelho.");
            }

            String erro = meta.get(SyncMeta.ULTIMO_ERRO);
            if (erro != null) {
                texto.append("\n\n").append(erro);
            }

            long desvio = meta.getLong(SyncMeta.DESVIO_RELOGIO, 0L);
            if (Math.abs(desvio) > 5 * 60 * 1000L) {
                texto.append("\n\nO relógio deste aparelho está ")
                        .append(Math.abs(desvio) / 60000L)
                        .append(" minutos fora do horário real. ")
                        .append("As datas do histórico podem parecer erradas.");
            }
        } catch (Exception e) {
            texto.append("Não foi possível ler o estado da sincronização.");
        }

        return texto.toString();
    }

    private void toggleMode() {
        registerMode = !registerMode;
        nameLayout.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        passwordRules.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        primaryButton.setText(registerMode ? "Criar conta" : "Entrar");
        toggleModeButton.setText(registerMode ? "Já tenho conta" : "Ainda não tenho conta");
        legalNotice.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        showMessage(null);
        if (registerMode) {
            refreshPasswordRules();
        }
    }

    private void refreshPasswordRules() {
        if (!registerMode || passwordRules.getVisibility() != View.VISIBLE) {
            return;
        }
        String senha = passwordField.getText() == null ? "" : passwordField.getText().toString();
        String email = emailField.getText() == null ? "" : emailField.getText().toString().trim();
        PasswordPolicy.render(ruleLength, ruleCommon, ruleRepeated, ruleEmail,
                PasswordPolicy.check(senha, email), !senha.isEmpty());
    }

    // -------------------------------------------------------------------------
    // Ações
    // -------------------------------------------------------------------------

    private void submitCredentials() {
        String nome = nameField.getText().toString().trim();
        String email = emailField.getText().toString().trim();
        String senha = passwordField.getText().toString();

        if (TextUtils.isEmpty(email) || TextUtils.isEmpty(senha)) {
            showMessage("Informe e-mail e senha.");
            return;
        }
        if (registerMode && TextUtils.isEmpty(nome)) {
            showMessage("Informe seu nome.");
            return;
        }
        if (registerMode) {
            PasswordPolicy.Result regras = PasswordPolicy.check(senha, email);
            refreshPasswordRules();
            if (!regras.isValid()) {
                showMessage(regras.problems.get(0));
                return;
            }
        }

        setBusy(true);
        executor.execute(() -> {
            try {
                if (registerMode) {
                    accounts.register(nome, email, senha);
                } else {
                    accounts.login(email, senha);
                }
                List<AccountService.Workspace> workspaces = accounts.listWorkspaces();

                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    // A senha não fica em memória depois do uso: a tela pode
                    // permanecer aberta em segundo plano por muito tempo.
                    passwordField.setText("");
                    onSignedIn(workspaces);
                });

            } catch (ApiException e) {
                Log.w(TAG, "autenticação recusada: " + e.getCode(), e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage(e.userMessage());
                });
            } catch (Exception e) {
                // Sem este catch o executor morre em silêncio, o spinner fica
                // para sempre e o logcat filtrado pelo pacote não mostra nada.
                Log.e(TAG, "falha inesperada ao autenticar", e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage("Não foi possível falar com o servidor. Tente de novo.");
                });
            }
        });
    }

    /**
     * Depois de entrar, é preciso saber com qual empresa este aparelho trabalha.
     *
     * Quem acabou de se cadastrar não tem nenhuma e cria a primeira; quem
     * participa de várias escolhe. Sem essa decisão, não há para onde enviar os
     * dados — por isso a tela não fica utilizável até que ela seja tomada.
     */
    private void onSignedIn(List<AccountService.Workspace> workspaces) {
        if (workspaces.isEmpty()) {
            promptCreateWorkspace();
            return;
        }
        if (workspaces.size() == 1) {
            selectWorkspace(workspaces.get(0));
            return;
        }

        List<String> nomes = new ArrayList<>();
        for (AccountService.Workspace workspace : workspaces) {
            nomes.add(workspace.name + " (" + workspace.role + ")");
        }

        new AlertDialog.Builder(this)
                .setTitle("Escolha a empresa")
                .setCancelable(false)
                .setItems(nomes.toArray(new String[0]),
                        (dialog, which) -> selectWorkspace(workspaces.get(which)))
                .show();
    }

    private void promptCreateWorkspace() {
        EditText campo = new EditText(this);
        campo.setHint("Nome da empresa");
        campo.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        // O setView do AlertDialog cola o conteúdo nas bordas; o título e a
        // mensagem já vêm com recuo. Sem este padding a linha do input atravessa
        // a caixa inteira.
        LinearLayout caixa = new LinearLayout(this);
        caixa.setOrientation(LinearLayout.VERTICAL);
        int margem = (int) (24 * getResources().getDisplayMetrics().density);
        caixa.setPadding(margem, margem / 2, margem, 0);
        caixa.addView(campo);

        new AlertDialog.Builder(this)
                .setTitle("Criar empresa")
                .setMessage("Seu estoque será guardado nesta empresa. "
                        + "Depois você pode convidar outras pessoas para acessá-la.")
                .setView(caixa)
                .setCancelable(false)
                .setPositiveButton("Criar", (dialog, which) -> {
                    String nome = campo.getText().toString().trim();
                    if (nome.isEmpty()) {
                        promptCreateWorkspace();
                        return;
                    }
                    createWorkspace(nome);
                })
                .show();
    }

    private void createWorkspace(String nome) {
        setBusy(true);
        executor.execute(() -> {
            try {
                AccountService.Workspace workspace = accounts.createWorkspace(nome);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    selectWorkspace(workspace);
                });
            } catch (ApiException e) {
                Log.w(TAG, "falha ao criar empresa: " + e.getCode(), e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage(e.userMessage());
                });
            } catch (Exception e) {
                Log.e(TAG, "falha inesperada ao criar empresa", e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage("Não foi possível criar a empresa. Tente de novo.");
                });
            }
        });
    }

    private void selectWorkspace(AccountService.Workspace workspace) {
        accounts.selectWorkspace(workspace);
        render();
        setBusy(true);
        executor.execute(() -> {
            boolean podeSincronizar = false;
            try {
                podeSincronizar = new EntitlementManager(this).refresh();
            } catch (ApiException ignored) {
                podeSincronizar = new EntitlementManager(this).canSync();
            }
            final boolean syncLiberada = podeSincronizar;
            main.post(() -> {
                if (isFinishing()) {
                    return;
                }
                setBusy(false);
                // Reavalia o SyncGate (assinatura, protocolo, sessão) e só então agenda.
                // Chamar syncNow com o portão fechado adiava a primeira sincronização
                // em até 15 minutos.
                SyncBootstrap.start(this);
                render();
                Toast.makeText(this, mensagemAposEntrar(syncLiberada), Toast.LENGTH_LONG).show();
            });
        });
    }

    private String mensagemAposEntrar(boolean syncLiberada) {
        StringBuilder texto = new StringBuilder("Conta conectada.");
        if (session.needsEmailVerification()) {
            texto.append(" Confirme o e-mail com o código que enviamos para convidar pessoas.");
        }
        if (syncLiberada) {
            texto.append(" A primeira sincronização vai começar.");
        } else {
            texto.append(" A sincronização na nuvem exige assinatura.");
        }
        return texto.toString();
    }

    // -------------------------------------------------------------------------
    // Convites
    // -------------------------------------------------------------------------

    /**
     * Entrada pelo código recebido por e-mail.
     *
     * O código é consultado antes de qualquer coisa para que a pessoa veja em
     * qual empresa está entrando e com qual papel. Aceitar às cegas um convite
     * dá a estranhos acesso ao estoque de quem convidou.
     */
    private void promptInviteCode() {
        EditText campo = new EditText(this);
        campo.setHint("Código do convite");

        new AlertDialog.Builder(this)
                .setTitle("Recebi um convite")
                .setMessage("Cole aqui o código que chegou no seu e-mail.")
                .setView(campo)
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Continuar", (dialog, which) -> {
                    String codigo = campo.getText().toString().trim();
                    if (!codigo.isEmpty()) {
                        previewInvite(codigo);
                    }
                })
                .show();
    }

    private void previewInvite(String codigo) {
        setBusy(true);
        executor.execute(() -> {
            try {
                TeamClient.Preview preview = new TeamClient(this).previewInvite(codigo);
                main.post(() -> {
                    setBusy(false);
                    confirmInvite(codigo, preview);
                });
            } catch (ApiException e) {
                main.post(() -> {
                    setBusy(false);
                    showMessage(e.userMessage());
                });
            }
        });
    }

    private void confirmInvite(String codigo, TeamClient.Preview preview) {
        String resumo = "Empresa: " + preview.empresa
                + "\nSeu papel: " + TeamClient.papelLegivel(preview.papel)
                + "\nConvite enviado para: " + preview.email;

        // Quem já tem conta precisa provar que é dono dela. Sem isso, qualquer
        // pessoa com o código entraria usando o e-mail de outra.
        if (preview.temConta && !session.isSignedIn()) {
            new AlertDialog.Builder(this)
                    .setTitle("Entre na sua conta")
                    .setMessage(resumo + "\n\nJá existe uma conta com esse e-mail. "
                            + "Entre nela e toque em \"Recebi um convite\" de novo.")
                    .setPositiveButton("OK", null)
                    .show();
            return;
        }

        if (session.isSignedIn()) {
            new AlertDialog.Builder(this)
                    .setTitle("Entrar na empresa")
                    .setMessage(resumo)
                    .setNegativeButton("Agora não", null)
                    .setPositiveButton("Aceitar convite",
                            (dialog, which) -> acceptInvite(codigo, null, null))
                    .show();
            return;
        }

        promptInviteAccount(codigo, preview, resumo);
    }

    /** Convidado sem conta: nome e senha são criados aqui mesmo. */
    private void promptInviteAccount(String codigo, TeamClient.Preview preview, String resumo) {
        View caixa = LayoutInflater.from(this).inflate(R.layout.dialog_invite_account, null);
        EditText nome = caixa.findViewById(R.id.inviteNameField);
        EditText senha = caixa.findViewById(R.id.invitePasswordField);
        View regras = caixa.findViewById(R.id.invitePasswordRules);
        if (regras == null) {
            regras = caixa.findViewById(R.id.passwordRules);
        }
        regras.setVisibility(View.VISIBLE);
        TextView legalConvite = caixa.findViewById(R.id.inviteLegalNotice);
        if (legalConvite != null) {
            LegalDocuments.bindInviteNotice(legalConvite);
        }
        TextView ruleLengthInvite = caixa.findViewById(R.id.ruleLength);
        TextView ruleCommonInvite = caixa.findViewById(R.id.ruleCommon);
        TextView ruleRepeatedInvite = caixa.findViewById(R.id.ruleRepeated);
        TextView ruleEmailInvite = caixa.findViewById(R.id.ruleEmail);
        String emailConvite = preview.email != null ? preview.email : "";

        TextWatcher watcher = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                String digitada = senha.getText() == null ? "" : senha.getText().toString();
                PasswordPolicy.render(ruleLengthInvite, ruleCommonInvite, ruleRepeatedInvite,
                        ruleEmailInvite, PasswordPolicy.check(digitada, emailConvite),
                        !digitada.isEmpty());
            }
        };
        senha.addTextChangedListener(watcher);
        PasswordPolicy.render(ruleLengthInvite, ruleCommonInvite, ruleRepeatedInvite,
                ruleEmailInvite, PasswordPolicy.check("", emailConvite), false);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Criar sua conta")
                .setMessage(resumo + "\n\nO e-mail do convite já fica confirmado.")
                .setView(caixa)
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Entrar na empresa", null)
                .create();
        dialog.setOnShowListener(shown -> {
            Button confirmar = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            confirmar.setOnClickListener(v -> {
                String texto = nome.getText() == null ? "" : nome.getText().toString().trim();
                String segredo = senha.getText() == null ? "" : senha.getText().toString();
                if (TextUtils.isEmpty(texto) || TextUtils.isEmpty(segredo)) {
                    showMessage("Informe seu nome e crie uma senha.");
                    return;
                }
                PasswordPolicy.Result resultado = PasswordPolicy.check(segredo, emailConvite);
                PasswordPolicy.render(ruleLengthInvite, ruleCommonInvite, ruleRepeatedInvite,
                        ruleEmailInvite, resultado, true);
                if (!resultado.isValid()) {
                    showMessage(resultado.problems.get(0));
                    return;
                }
                dialog.dismiss();
                acceptInvite(codigo, texto, segredo);
            });
        });
        dialog.show();

        if (preview.email != null) {
            emailField.setText(preview.email);
        }
    }

    private void acceptInvite(String codigo, String nome, String senha) {
        setBusy(true);
        executor.execute(() -> {
            try {
                String workspaceId = new TeamClient(this).acceptInvite(codigo, nome, senha);
                List<AccountService.Workspace> workspaces = accounts.listWorkspaces();

                AccountService.Workspace escolhida = null;
                for (AccountService.Workspace workspace : workspaces) {
                    if (workspace.id != null && workspace.id.equals(workspaceId)) {
                        escolhida = workspace;
                    }
                }
                final AccountService.Workspace destino = escolhida;

                String atual = session.workspaceId();
                main.post(() -> {
                    setBusy(false);
                    if (destino == null) {
                        onSignedIn(workspaces);
                    } else if (atual == null || atual.equals(destino.id)) {
                        selectWorkspace(destino);
                    } else {
                        avisarEmpresaAdicional(destino);
                    }
                });

            } catch (ApiException e) {
                main.post(() -> {
                    setBusy(false);
                    showMessage(e.userMessage());
                });
            }
        });
    }

    /**
     * Entrou numa segunda empresa sem trocar a deste aparelho.
     *
     * Trocar a empresa aqui misturaria o estoque das duas: o que está na fila
     * de envio foi registrado pensando na empresa atual, e subiria para a
     * errada. A troca continua possível saindo e entrando de novo, quando não
     * há nada pendente.
     */
    private void avisarEmpresaAdicional(AccountService.Workspace nova) {
        new AlertDialog.Builder(this)
                .setTitle("Você entrou em " + nova.name)
                .setMessage("Este aparelho continua sincronizando com "
                        + session.workspaceName() + ". Para usá-lo com "
                        + nova.name + ", saia da conta e entre de novo escolhendo essa empresa.")
                .setPositiveButton("Entendi", null)
                .show();
        render();
    }

    private void syncNow() {
        if (session.workspaceId() == null) {
            Toast.makeText(this, "Escolha uma empresa para sincronizar.", Toast.LENGTH_LONG).show();
            return;
        }

        RemoteConfig config = new RemoteConfig(this);
        if (!config.isSyncEnabled()) {
            Toast.makeText(this,
                    "A sincronização está temporariamente desativada. Os dados seguem neste aparelho.",
                    Toast.LENGTH_LONG).show();
            return;
        }
        if (!config.isProtocolSupported()) {
            Toast.makeText(this,
                    "Atualize o app pela Play Store para voltar a sincronizar.",
                    Toast.LENGTH_LONG).show();
            return;
        }

        EntitlementManager entitlements = new EntitlementManager(this);
        if (entitlements.canSync()) {
            solicitarSincronizacao();
            return;
        }

        setBusy(true);
        executor.execute(() -> {
            try {
                entitlements.refresh();
            } catch (ApiException ignored) {
                // Sem rede, vale o retrato local — que já disse que não há direito.
            }
            main.post(() -> {
                if (isFinishing()) {
                    return;
                }
                setBusy(false);
                if (entitlements.canSync()) {
                    solicitarSincronizacao();
                } else if (entitlements.isStale()) {
                    Toast.makeText(AccountActivity.this,
                            "Não foi possível confirmar a assinatura. Tente de novo com internet. "
                                    + "Os dados seguem neste aparelho.",
                            Toast.LENGTH_LONG).show();
                    render();
                } else {
                    informarAssinaturaObrigatoria();
                }
            });
        });
    }

    private void solicitarSincronizacao() {
        // O bootstrap reavalia o interruptor (sessão + assinatura). Sem isso,
        // um toque logo após o login encontrava o portão ainda fechado e o
        // toast de "solicitada" não correspondia a trabalho nenhum.
        SyncBootstrap.start(this);
        SyncScheduler.syncNow(this);
        Toast.makeText(this, "Sincronização solicitada.", Toast.LENGTH_SHORT).show();
        // Um atraso curto dá tempo do worker registrar o resultado antes de a
        // tela reler o estado.
        main.postDelayed(this::render, 1500);
    }

    /**
     * O botão continua visível de propósito: escondê-lo faria a pessoa achar
     * que a nuvem não existe. O diálogo diz o que falta e leva à assinatura.
     */
    private void informarAssinaturaObrigatoria() {
        String mensagem;
        if (PremiumManager.getInstance(this).isPro()) {
            mensagem = "Você já possui a antiga Versão PRO: recursos premium e sem anúncios neste aparelho. "
                    + "A sincronização na nuvem é exclusiva da assinatura. "
                    + "Nada foi enviado nem apagado.";
        } else {
            mensagem = "A sincronização na nuvem é exclusiva para assinantes. "
                    + "Sua conta, a equipe e os dados deste aparelho continuam "
                    + "disponíveis. Nada foi enviado nem apagado.";
        }
        new AlertDialog.Builder(this)
                .setTitle("Assinatura necessária")
                .setMessage(mensagem)
                .setNegativeButton("Agora não", null)
                .setPositiveButton("Ver assinatura", (dialog, which) ->
                        SubscriptionActivity.open(this))
                .show();
        render();
    }

    private void showDiagnostics() {
        setBusy(true);
        executor.execute(() -> {
            Diagnostics.Report report = new Diagnostics(LocalDb.open(this)).run();
            List<OutboxRepository.Operation> recusadas =
                    new OutboxRepository(LocalDb.open(this)).failures();
            main.post(() -> {
                setBusy(false);
                new AlertDialog.Builder(this)
                        .setTitle("Dados deste aparelho")
                        .setMessage(describe(report) + describeRecusadas(recusadas))
                        .setPositiveButton("OK", null)
                        .show();
            });
        });
    }

    /**
     * Lista o que a nuvem recusou em definitivo.
     *
     * Essas alterações não voltam a ser tentadas, então precisam estar visíveis
     * em algum lugar. Descobrir semanas depois que faltam registros na nuvem é
     * bem pior do que ler aqui que um nome já estava em uso.
     */
    private String describeRecusadas(List<OutboxRepository.Operation> recusadas) {
        if (recusadas.isEmpty()) {
            return "";
        }

        StringBuilder texto = new StringBuilder("\n\nAlterações não aceitas pela nuvem:\n");
        for (OutboxRepository.Operation operacao : recusadas) {
            texto.append("• ").append(operacao.entityType).append(": ")
                    .append(operacao.lastError == null ? "recusada" : operacao.lastError)
                    .append("\n");
        }
        texto.append("Os dados continuam neste aparelho.");
        return texto.toString();
    }

    private String describe(Diagnostics.Report report) {
        StringBuilder texto = new StringBuilder();
        texto.append("Produtos: ").append(report.produtos).append("\n");
        if (report.produtosExcluidos > 0) {
            texto.append("Produtos excluídos (mantidos no histórico): ")
                    .append(report.produtosExcluidos).append("\n");
        }
        texto.append("Movimentações: ").append(report.movimentacoes).append("\n");
        texto.append("Arquivo íntegro: ").append(report.integridadeOk ? "sim" : "NÃO").append("\n");

        if (report.movimentacoesOrfas > 0) {
            texto.append("\n").append(report.movimentacoesOrfas)
                    .append(" movimentação(ões) sem produto correspondente. ")
                    .append("São de produtos renomeados ou excluídos antes desta versão; ")
                    .append("continuam guardadas.\n");
        }
        if (report.quantidadesInvalidas > 0) {
            texto.append("\n").append(report.quantidadesInvalidas)
                    .append(" produto(s) com quantidade que não é número.\n");
        }
        if (!report.nomesDuplicados.isEmpty()) {
            texto.append("\nNomes repetidos:\n");
            for (String nome : report.nomesDuplicados) {
                texto.append("• ").append(nome).append("\n");
            }
        }
        if (!report.saldosDivergentes.isEmpty()) {
            texto.append("\nSaldos que não batem com o histórico:\n");
            for (String linha : report.saldosDivergentes) {
                texto.append("• ").append(linha).append("\n");
            }
            texto.append("Isso é esperado em estoques ajustados antes desta versão. ")
                    .append("O saldo mostrado na lista continua sendo o válido.\n");
        }
        if (report.isClean()) {
            texto.append("\nNenhum problema encontrado.");
        }
        return texto.toString();
    }

    private void confirmLogout() {
        new AlertDialog.Builder(this)
                .setTitle("Sair da conta")
                .setMessage("Seus produtos e movimentações continuam neste aparelho. "
                        + "Alterações ainda não enviadas deixarão de ser sincronizadas.")
                .setNegativeButton("Voltar", null)
                .setPositiveButton("Sair", (dialog, which) -> logout())
                .show();
    }

    private void logout() {
        setBusy(true);
        executor.execute(() -> {
            try {
                // Limpa fila e cursor ANTES de descartar a sessão: senão a
                // próxima conta herdaria operações e um changeSeq da empresa
                // anterior e empurraria dados cruzados (ou pularia o pull).
                android.database.sqlite.SQLiteDatabase db = LocalDb.open(this);
                db.beginTransaction();
                try {
                    new OutboxRepository(db).clear();
                    new SyncMeta(db).clear();
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }

                accounts.logout();
                new EntitlementManager(this).clear();
                new PendingPurchase(this).clear();
                SyncScheduler.cancelAll(this);
                br.com.gameloop.estoquesimples.data.SyncGate.setActive(false);

                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    render();
                    Toast.makeText(this, "Você saiu da conta.", Toast.LENGTH_SHORT).show();
                });
            } catch (Exception e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage("Não foi possível sair da conta. Tente de novo.");
                });
            }
        });
    }

    // -------------------------------------------------------------------------
    // Apoio
    // -------------------------------------------------------------------------

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        primaryButton.setEnabled(!busy);
        toggleModeButton.setEnabled(!busy);
        View syncNowButton = findViewById(R.id.syncNowButton);
        if (syncNowButton != null) {
            syncNowButton.setEnabled(!busy);
        }
    }

    private void showMessage(String mensagem) {
        if (mensagem == null) {
            messageView.setVisibility(View.GONE);
            return;
        }
        messageView.setText(mensagem);
        messageView.setVisibility(View.VISIBLE);
    }

    private String formatDate(long millis) {
        return new SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault())
                .format(new Date(millis));
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
        executor.shutdown();
        super.onDestroy();
    }
}
