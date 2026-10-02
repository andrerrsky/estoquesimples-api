package br.com.gameloop.estoquesimples;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Patterns;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.android.material.textfield.TextInputLayout;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.SupportClient;

/**
 * Nova solicitação de suporte. Com conta, a identificação vem da sessão;
 * sem conta, a pessoa pode deixar nome e e-mail (opcionais) — a resposta
 * chega de qualquer jeito por notificação neste aparelho.
 */
public class SupportNewActivity extends BaseActivity {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private ScrollView scrollView;
    private TextView messageView;
    private TextInputLayout subjectLayout;
    private TextInputLayout messageLayout;
    private TextInputLayout emailLayout;
    private TextInputLayout nameLayout;
    private Button sendButton;
    private ProgressBar progress;
    private TextView[] chips;
    private String category = SupportClient.CATEGORY_QUESTION;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_support_new);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Nova solicitação");
        }

        scrollView = findViewById(R.id.scrollView);
        messageView = findViewById(R.id.messageView);
        subjectLayout = findViewById(R.id.subjectLayout);
        messageLayout = findViewById(R.id.messageLayout);
        emailLayout = findViewById(R.id.emailLayout);
        nameLayout = findViewById(R.id.nameLayout);
        sendButton = findViewById(R.id.sendButton);
        progress = findViewById(R.id.progress);

        boolean signedIn = SessionManager.get(this).isSignedIn();
        findViewById(R.id.contactGroup).setVisibility(signedIn ? View.GONE : View.VISIBLE);

        chips = new TextView[] {
                findViewById(R.id.chipQuestion),
                findViewById(R.id.chipProblem),
                findViewById(R.id.chipSuggestion),
                findViewById(R.id.chipBilling),
                findViewById(R.id.chipAccount),
                findViewById(R.id.chipOther),
        };
        String[] keys = {
                SupportClient.CATEGORY_QUESTION,
                SupportClient.CATEGORY_PROBLEM,
                SupportClient.CATEGORY_SUGGESTION,
                SupportClient.CATEGORY_BILLING,
                SupportClient.CATEGORY_ACCOUNT,
                SupportClient.CATEGORY_OTHER,
        };
        for (int i = 0; i < chips.length; i++) {
            final String key = keys[i];
            chips[i].setOnClickListener(v -> selecionarCategoria(key));
        }
        selecionarCategoria(category);

        sendButton.setOnClickListener(v -> enviar());
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
    }

    private void selecionarCategoria(String key) {
        category = key;
        String[] keys = {
                SupportClient.CATEGORY_QUESTION,
                SupportClient.CATEGORY_PROBLEM,
                SupportClient.CATEGORY_SUGGESTION,
                SupportClient.CATEGORY_BILLING,
                SupportClient.CATEGORY_ACCOUNT,
                SupportClient.CATEGORY_OTHER,
        };
        for (int i = 0; i < chips.length; i++) {
            chips[i].setSelected(keys[i].equals(key));
        }
    }

    private static String texto(TextInputLayout layout) {
        return layout.getEditText() == null || layout.getEditText().getText() == null
                ? ""
                : layout.getEditText().getText().toString().trim();
    }

    private void enviar() {
        showMessage(null);
        boolean assuntoOk = FormValidation.required(subjectLayout, "Diga em poucas palavras do que se trata.");
        boolean mensagemOk = FormValidation.required(messageLayout, "Conte o que aconteceu.");
        String email = texto(emailLayout);
        boolean emailOk = FormValidation.check(emailLayout,
                !email.isEmpty() && !Patterns.EMAIL_ADDRESS.matcher(email).matches(),
                "Informe um e-mail válido ou deixe em branco.");
        if (!assuntoOk || !mensagemOk || !emailOk) {
            FormValidation.focusFirstError(scrollView, subjectLayout, messageLayout, emailLayout);
            return;
        }

        final String assunto = texto(subjectLayout);
        final String mensagem = texto(messageLayout);
        final String nome = texto(nameLayout);
        final String contato = email.toLowerCase();

        setBusy(true);
        executor.execute(() -> {
            try {
                SupportClient.Ticket ticket = new SupportClient(this).create(assunto, mensagem, category, contato, nome);
                Analytics.track(this, "support.ticket_submitted", Analytics.props("category", category));
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    Toast.makeText(this, "Solicitação #" + ticket.number + " enviada. Avisamos quando responder.", Toast.LENGTH_LONG).show();
                    startActivity(SupportTicketActivity.intent(this, ticket.id));
                    finish();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    if (!ConnectivityPrompt.report(this, e, this::enviar)) {
                        showMessage(e.userMessage());
                    }
                });
            } catch (Exception e) {
                android.util.Log.e("SupportNewActivity", "falha ao abrir solicitação", e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    showMessage("Não foi possível enviar agora. Tente de novo.");
                });
            }
        });
    }

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        sendButton.setEnabled(!busy);
    }

    private void showMessage(String message) {
        if (message == null) {
            messageView.setVisibility(View.GONE);
            return;
        }
        messageView.setText(message);
        messageView.setVisibility(View.VISIBLE);
        scrollView.smoothScrollTo(0, 0);
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
