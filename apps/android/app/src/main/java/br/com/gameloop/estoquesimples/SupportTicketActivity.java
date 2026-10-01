package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;

import com.google.android.material.textfield.TextInputLayout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SupportClient;

/**
 * Conversa de uma solicitação: mensagens da pessoa à esquerda, da equipe à
 * direita, avisos do sistema ao centro. Escrever numa solicitação resolvida
 * a reabre. Abrir a tela marca as respostas como lidas.
 */
public class SupportTicketActivity extends BaseActivity {

    public static final String EXTRA_TICKET_ID = "br.com.gameloop.estoquesimples.SUPPORT_TICKET_ID";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private SupportClient client;
    private String ticketId;
    private SupportClient.Ticket ticket;
    private final List<SupportClient.Message> messages = new ArrayList<>();
    private MessageAdapter adapter;

    private TextView subjectView;
    private TextView metaView;
    private TextView messageView;
    private TextView resolvedView;
    private ProgressBar progress;
    private ListView listView;
    private TextInputLayout replyLayout;
    private Button sendButton;
    private Button resolveButton;

    public static Intent intent(Context context, String ticketId) {
        return new Intent(context, SupportTicketActivity.class).putExtra(EXTRA_TICKET_ID, ticketId);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_support_ticket);

        ticketId = getIntent().getStringExtra(EXTRA_TICKET_ID);
        if (ticketId == null || ticketId.isEmpty()) {
            finish();
            return;
        }

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Solicitação");
        }

        client = new SupportClient(this);
        subjectView = findViewById(R.id.subject);
        metaView = findViewById(R.id.meta);
        messageView = findViewById(R.id.messageView);
        resolvedView = findViewById(R.id.resolvedView);
        progress = findViewById(R.id.progress);
        listView = findViewById(R.id.messageList);
        replyLayout = findViewById(R.id.replyLayout);
        sendButton = findViewById(R.id.sendButton);
        resolveButton = findViewById(R.id.resolveButton);

        adapter = new MessageAdapter(this, messages);
        listView.setAdapter(adapter);

        sendButton.setOnClickListener(v -> enviar());
        resolveButton.setOnClickListener(v -> confirmarResolver());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String outro = intent.getStringExtra(EXTRA_TICKET_ID);
        if (outro != null && !outro.equals(ticketId)) {
            ticketId = outro;
            messages.clear();
            adapter.notifyDataSetChanged();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        carregar();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
    }

    private void carregar() {
        showMessage(null);
        setBusy(messages.isEmpty());
        executor.execute(() -> {
            try {
                SupportClient.Thread thread = client.get(ticketId);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    mostrar(thread);
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    if (!ConnectivityPrompt.report(this, e, this::carregar)) {
                        showMessage(e.userMessage());
                    }
                });
            } catch (Exception e) {
                android.util.Log.e("SupportTicketActivity", "falha ao carregar a conversa", e);
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

    private void mostrar(SupportClient.Thread thread) {
        ticket = thread.ticket;
        messages.clear();
        messages.addAll(thread.messages);
        adapter.notifyDataSetChanged();
        if (!messages.isEmpty()) {
            listView.setSelection(messages.size() - 1);
        }

        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle("Solicitação #" + ticket.number);
        }
        subjectView.setText(ticket.subject);
        metaView.setText(ticket.categoryLabel + " · " + ticket.statusLabel()
                + " · aberta " + SupportClient.relative(ticket.createdAt));

        boolean resolvida = ticket.isResolved();
        resolvedView.setVisibility(resolvida ? View.VISIBLE : View.GONE);
        resolveButton.setVisibility(resolvida ? View.GONE : View.VISIBLE);
        replyLayout.setHint(resolvida ? "Escreva para reabrir" : "Escreva sua mensagem");
    }

    private static String texto(TextInputLayout layout) {
        return layout.getEditText() == null || layout.getEditText().getText() == null
                ? ""
                : layout.getEditText().getText().toString().trim();
    }

    private void enviar() {
        final String mensagem = texto(replyLayout);
        if (!FormValidation.required(replyLayout, "Escreva a mensagem antes de enviar.")) {
            return;
        }
        setBusy(true);
        sendButton.setEnabled(false);
        executor.execute(() -> {
            try {
                client.reply(ticketId, mensagem);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    sendButton.setEnabled(true);
                    if (replyLayout.getEditText() != null) {
                        replyLayout.getEditText().setText("");
                    }
                    carregar();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    sendButton.setEnabled(true);
                    if (!ConnectivityPrompt.report(this, e, this::enviar)) {
                        showMessage(e.userMessage());
                    }
                });
            } catch (Exception e) {
                android.util.Log.e("SupportTicketActivity", "falha ao enviar mensagem", e);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    sendButton.setEnabled(true);
                    showMessage("Não foi possível enviar agora. Tente de novo.");
                });
            }
        });
    }

    private void confirmarResolver() {
        new AlertDialog.Builder(this)
                .setTitle("Marcar como resolvida?")
                .setMessage("Se precisar de novo, é só escrever nesta conversa que ela reabre.")
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Resolver", (dialog, which) -> resolver())
                .show();
    }

    private void resolver() {
        setBusy(true);
        executor.execute(() -> {
            try {
                client.resolve(ticketId);
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    Toast.makeText(this, "Solicitação resolvida. Obrigado!", Toast.LENGTH_SHORT).show();
                    carregar();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    if (!ConnectivityPrompt.report(this, e, this::resolver)) {
                        showMessage(e.userMessage());
                    }
                });
            } catch (Exception e) {
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

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
    }

    private void showMessage(String message) {
        if (message == null) {
            messageView.setVisibility(View.GONE);
            return;
        }
        messageView.setText(message);
        messageView.setVisibility(View.VISIBLE);
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private static final class MessageAdapter extends ArrayAdapter<SupportClient.Message> {

        MessageAdapter(Context context, List<SupportClient.Message> items) {
            super(context, R.layout.item_support_message, items);
        }

        @NonNull
        @Override
        public View getView(int position, View convertView, @NonNull ViewGroup parent) {
            View view = convertView != null
                    ? convertView
                    : LayoutInflater.from(getContext()).inflate(R.layout.item_support_message, parent, false);
            SupportClient.Message message = getItem(position);
            if (message == null) {
                return view;
            }
            LinearLayout bubble = view.findViewById(R.id.bubble);
            TextView author = view.findViewById(R.id.author);
            TextView body = view.findViewById(R.id.body);
            TextView time = view.findViewById(R.id.time);

            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) bubble.getLayoutParams();
            int afastamento = (int) (40 * getContext().getResources().getDisplayMetrics().density);
            body.setText(message.body);
            time.setText(SupportClient.relative(message.createdAt));

            if ("system".equals(message.author)) {
                params.gravity = Gravity.CENTER_HORIZONTAL;
                params.setMarginStart(0);
                params.setMarginEnd(0);
                bubble.setBackground(null);
                author.setVisibility(View.GONE);
                body.setTextAppearance(R.style.TextAppearance_Estoque_Caption);
                body.setGravity(Gravity.CENTER_HORIZONTAL);
                time.setVisibility(View.GONE);
            } else if ("support".equals(message.author)) {
                params.gravity = Gravity.END;
                params.setMarginStart(afastamento);
                params.setMarginEnd(0);
                bubble.setBackgroundResource(R.drawable.bg_surface);
                author.setVisibility(View.VISIBLE);
                author.setText(message.authorName == null || message.authorName.isEmpty()
                        ? "Equipe Estoque Simples"
                        : message.authorName + " · Estoque Simples");
                body.setTextAppearance(R.style.TextAppearance_Estoque_Body);
                body.setTextColor(getContext().getColor(R.color.color_text));
                body.setGravity(Gravity.START);
                time.setVisibility(View.VISIBLE);
            } else {
                params.gravity = Gravity.START;
                params.setMarginStart(0);
                params.setMarginEnd(afastamento);
                bubble.setBackgroundResource(R.drawable.bg_surface_muted);
                author.setVisibility(View.VISIBLE);
                author.setText("Você");
                body.setTextAppearance(R.style.TextAppearance_Estoque_Body);
                body.setTextColor(getContext().getColor(R.color.color_text));
                body.setGravity(Gravity.START);
                time.setVisibility(View.VISIBLE);
            }
            bubble.setLayoutParams(params);
            return view;
        }
    }
}
