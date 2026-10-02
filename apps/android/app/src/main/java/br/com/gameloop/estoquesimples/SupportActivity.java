package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.SupportClient;

/**
 * Ajuda e suporte: lista as solicitações da pessoa (ou da instalação, sem
 * conta) e abre a tela de nova solicitação. Substitui o "mande um e-mail"
 * da tela Sobre: a conversa fica no app e a resposta chega por notificação.
 */
public class SupportActivity extends BaseActivity {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private SupportClient client;
    private ProgressBar progress;
    private TextView messageView;
    private TextView emptyView;
    private TextView listTitle;
    private ListView listView;
    private TicketAdapter adapter;
    private final List<SupportClient.Ticket> tickets = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_support);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Falar com o suporte");
        }

        client = new SupportClient(this);
        progress = findViewById(R.id.progress);
        messageView = findViewById(R.id.messageView);
        emptyView = findViewById(R.id.emptyView);
        listTitle = findViewById(R.id.listTitle);
        listView = findViewById(R.id.ticketList);

        adapter = new TicketAdapter(this, tickets);
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> {
            SupportClient.Ticket ticket = tickets.get(position);
            startActivity(SupportTicketActivity.intent(this, ticket.id));
        });

        findViewById(R.id.newTicketButton).setOnClickListener(v ->
                startActivity(new Intent(this, SupportNewActivity.class)));

        // Antes de abrir uma solicitação, a pessoa pode achar a resposta
        // pronta. CLEAR_TOP + SINGLE_TOP: quem veio da Central de ajuda
        // volta para ela em vez de empilhar ajuda → suporte → ajuda…
        findViewById(R.id.faqEntry).setOnClickListener(v ->
                startActivity(HelpActivity.intent(this, null)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)));
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
        setBusy(tickets.isEmpty());
        executor.execute(() -> {
            try {
                List<SupportClient.Ticket> lista = client.list();
                main.post(() -> {
                    if (isFinishing()) {
                        return;
                    }
                    setBusy(false);
                    mostrar(lista);
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
                android.util.Log.e("SupportActivity", "falha ao carregar solicitações", e);
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

    private void mostrar(List<SupportClient.Ticket> lista) {
        tickets.clear();
        tickets.addAll(lista);
        adapter.notifyDataSetChanged();
        boolean vazio = tickets.isEmpty();
        emptyView.setVisibility(vazio ? View.VISIBLE : View.GONE);
        listTitle.setVisibility(vazio ? View.GONE : View.VISIBLE);
        listView.setVisibility(vazio ? View.GONE : View.VISIBLE);
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

    private static final class TicketAdapter extends ArrayAdapter<SupportClient.Ticket> {

        TicketAdapter(Context context, List<SupportClient.Ticket> items) {
            super(context, R.layout.item_support_ticket, items);
        }

        @NonNull
        @Override
        public View getView(int position, View convertView, @NonNull ViewGroup parent) {
            View view = convertView != null
                    ? convertView
                    : LayoutInflater.from(getContext()).inflate(R.layout.item_support_ticket, parent, false);
            SupportClient.Ticket ticket = getItem(position);
            if (ticket == null) {
                return view;
            }
            TextView subject = view.findViewById(R.id.subject);
            TextView status = view.findViewById(R.id.status);
            TextView meta = view.findViewById(R.id.meta);
            View dot = view.findViewById(R.id.unreadDot);

            subject.setText(ticket.subject);
            subject.setTypeface(null, ticket.unread ? Typeface.BOLD : Typeface.NORMAL);
            dot.setVisibility(ticket.unread ? View.VISIBLE : View.GONE);
            status.setText(ticket.statusLabel());
            status.setBackgroundResource(ticket.isResolved() ? R.drawable.bg_chip : R.drawable.bg_type_badge);
            status.setTextColor(getContext().getColor(ticket.isResolved() ? R.color.color_text_muted : R.color.color_text_on_brand));
            meta.setText("#" + ticket.number + " · " + ticket.categoryLabel + " · " + SupportClient.relative(ticket.lastMessageAt));
            return view;
        }
    }
}
