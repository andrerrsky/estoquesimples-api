package br.com.gameloop.estoquesimples.sync;

import android.content.Context;
import android.os.Build;
import android.text.format.DateUtils;

import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

import br.com.gameloop.estoquesimples.BuildConfig;
import br.com.gameloop.estoquesimples.PremiumManager;
import br.com.gameloop.estoquesimples.data.Diagnostics;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.data.SyncMeta;

/**
 * Solicitações de suporte ({@code /v1/support}).
 *
 * Funciona com ou sem conta: toda chamada leva o {@code installId} do
 * aparelho e, quando há sessão, o Bearer. Quem abriu uma solicitação sem
 * conta e depois entrou continua vendo a mesma lista — a API vincula as
 * solicitações da instalação à conta.
 */
public final class SupportClient {

    public static final String CATEGORY_QUESTION = "question";
    public static final String CATEGORY_PROBLEM = "problem";
    public static final String CATEGORY_SUGGESTION = "suggestion";
    public static final String CATEGORY_BILLING = "billing";
    public static final String CATEGORY_ACCOUNT = "account";
    public static final String CATEGORY_OTHER = "other";

    private final Context context;
    private final ApiClient api;
    private final SessionManager session;

    public SupportClient(Context context) {
        this.context = context.getApplicationContext();
        this.api = new ApiClient();
        this.session = SessionManager.get(this.context);
    }

    public static final class Ticket {
        public final String id;
        public final int number;
        public final String subject;
        public final String category;
        public final String categoryLabel;
        public final String status;
        public final int messageCount;
        public final String lastMessageAt;
        public final String lastMessageBy;
        public final boolean unread;
        public final String createdAt;

        Ticket(JSONObject json) {
            id = json.optString("id", "");
            number = json.optInt("number", 0);
            subject = json.optString("subject", "");
            category = json.optString("category", CATEGORY_QUESTION);
            categoryLabel = json.optString("categoryLabel", categoryLabel(category));
            status = json.optString("status", "open");
            messageCount = json.optInt("messageCount", 0);
            lastMessageAt = json.optString("lastMessageAt", null);
            lastMessageBy = json.optString("lastMessageBy", "user");
            unread = json.optBoolean("unread", false);
            createdAt = json.optString("createdAt", null);
        }

        public boolean isResolved() {
            return "resolved".equals(status);
        }

        public String statusLabel() {
            switch (status) {
                case "answered":
                    return "Respondida";
                case "resolved":
                    return "Resolvida";
                default:
                    return "Aguardando resposta";
            }
        }
    }

    public static final class Message {
        public final String id;
        /** {@code user}, {@code support} ou {@code system}. */
        public final String author;
        public final String authorName;
        public final String body;
        public final String createdAt;

        Message(JSONObject json) {
            id = json.optString("id", "");
            author = json.optString("author", "user");
            authorName = json.optString("authorName", null);
            body = json.optString("body", "");
            createdAt = json.optString("createdAt", null);
        }
    }

    public static final class Thread {
        public final Ticket ticket;
        public final List<Message> messages;

        Thread(Ticket ticket, List<Message> messages) {
            this.ticket = ticket;
            this.messages = messages;
        }
    }

    public static String categoryLabel(String category) {
        if (category == null) {
            return "Dúvida";
        }
        switch (category) {
            case CATEGORY_PROBLEM:
                return "Problema";
            case CATEGORY_SUGGESTION:
                return "Sugestão";
            case CATEGORY_BILLING:
                return "Assinatura e pagamento";
            case CATEGORY_ACCOUNT:
                return "Conta e sincronização";
            case CATEGORY_OTHER:
                return "Outro";
            default:
                return "Dúvida";
        }
    }

    // -------------------------------------------------------------------------
    // Chamadas
    // -------------------------------------------------------------------------

    public List<Ticket> list() throws ApiException {
        JSONArray lista = api.get("/v1/support/tickets?installId=" + session.deviceId(), token())
                .body.optJSONArray("tickets");
        List<Ticket> tickets = new ArrayList<>();
        if (lista == null) {
            return tickets;
        }
        for (int i = 0; i < lista.length(); i++) {
            JSONObject item = lista.optJSONObject(i);
            if (item != null) {
                tickets.add(new Ticket(item));
            }
        }
        return tickets;
    }

    public Ticket create(String subject, String message, String category,
                         String contactEmail, String contactName) throws ApiException {
        try {
            JSONObject body = new JSONObject()
                    .put("installId", session.deviceId())
                    .put("subject", subject)
                    .put("message", message)
                    .put("category", category)
                    .put("device", deviceInfo(context))
                    .put("diagnostics", diagnostics());
            if (contactEmail != null && !contactEmail.isEmpty()) {
                body.put("contactEmail", contactEmail);
            }
            if (contactName != null && !contactName.isEmpty()) {
                body.put("contactName", contactName);
            }
            return new Ticket(api.post("/v1/support/tickets", body, token()).body);
        } catch (JSONException e) {
            throw local(e);
        }
    }

    public Thread get(String ticketId) throws ApiException {
        JSONObject body = api.get("/v1/support/tickets/" + ticketId + "?installId=" + session.deviceId(), token()).body;
        JSONObject ticket = body.optJSONObject("ticket");
        JSONArray lista = body.optJSONArray("messages");
        List<Message> messages = new ArrayList<>();
        if (lista != null) {
            for (int i = 0; i < lista.length(); i++) {
                JSONObject item = lista.optJSONObject(i);
                if (item != null) {
                    messages.add(new Message(item));
                }
            }
        }
        return new Thread(new Ticket(ticket == null ? new JSONObject() : ticket), messages);
    }

    public Ticket reply(String ticketId, String message) throws ApiException {
        try {
            JSONObject body = new JSONObject()
                    .put("installId", session.deviceId())
                    .put("message", message);
            JSONObject response = api.post("/v1/support/tickets/" + ticketId + "/messages", body, token()).body;
            JSONObject ticket = response.optJSONObject("ticket");
            return new Ticket(ticket == null ? new JSONObject() : ticket);
        } catch (JSONException e) {
            throw local(e);
        }
    }

    public Ticket resolve(String ticketId) throws ApiException {
        try {
            JSONObject body = new JSONObject().put("installId", session.deviceId());
            return new Ticket(api.post("/v1/support/tickets/" + ticketId + "/resolve", body, token()).body);
        } catch (JSONException e) {
            throw local(e);
        }
    }

    private static ApiException local(Throwable cause) {
        ApiException e = new ApiException(0, ApiException.FALHA_LOCAL, "Não foi possível montar a solicitação.", null);
        e.initCause(cause);
        return e;
    }

    /** Bearer quando há sessão válida; sem sessão (ou sem como renovar), anônimo. */
    private String token() {
        if (!session.isSignedIn()) {
            return null;
        }
        try {
            return session.accessToken();
        } catch (ApiException e) {
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // O que vai junto da solicitação
    // -------------------------------------------------------------------------

    /** Modelo, Android e versão do app. Nada pessoal. */
    public static JSONObject deviceInfo(Context context) throws JSONException {
        return new JSONObject()
                .put("model", Build.MODEL)
                .put("manufacturer", Build.MANUFACTURER)
                .put("osVersion", Build.VERSION.RELEASE)
                .put("sdkInt", Build.VERSION.SDK_INT)
                .put("appVersionCode", BuildConfig.VERSION_CODE)
                .put("appVersionName", BuildConfig.VERSION_NAME)
                .put("locale", Locale.getDefault().toLanguageTag())
                .put("timezone", TimeZone.getDefault().getID());
    }

    /**
     * Estado local que ajuda o atendimento: sessão, empresa, assinatura,
     * sincronização, quantidade de dados. Lê o banco — chamar fora da
     * thread principal. Qualquer falha devolve o que deu para coletar.
     */
    public JSONObject diagnostics() {
        JSONObject out = new JSONObject();
        try {
            out.put("signedIn", session.isSignedIn());
            if (session.isSignedIn()) {
                out.put("workspaceId", session.workspaceId());
                out.put("workspaceName", session.workspaceName());
                out.put("role", session.role());
            }
            PremiumManager premium = PremiumManager.getInstance(context);
            out.put("isPro", premium.isPro());
            EntitlementManager entitlement = new EntitlementManager(context);
            out.put("subscriptionState", entitlement.state());
            out.put("planKey", entitlement.planKey());
            out.put("canSync", entitlement.canSync());
            out.put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
        } catch (Exception ignored) {
            // segue com o que tem
        }
        try {
            SyncMeta meta = new SyncMeta(LocalDb.open(context));
            long ultima = meta.getLong(SyncMeta.ULTIMA_SINCRONIZACAO, 0L);
            out.put("lastSyncAt", ultima > 0 ? ultima : JSONObject.NULL);
            String erro = meta.get(SyncMeta.ULTIMO_ERRO);
            out.put("lastSyncError", erro == null || erro.isEmpty() ? JSONObject.NULL : erro);
            out.put("pendingConflicts", meta.getLong(SyncMeta.CONFLITOS_PENDENTES, 0L));
            out.put("initialUploadDone", meta.getBoolean(SyncMeta.CARGA_INICIAL_CONCLUIDA, false));
            OutboxRepository outbox = new OutboxRepository(LocalDb.open(context));
            out.put("pendingOperations", outbox.pendingCount());
            out.put("failedOperations", outbox.failedCount());
        } catch (Exception ignored) {
            // banco indisponível: segue sem
        }
        try {
            Diagnostics.Report report = new Diagnostics(LocalDb.open(context)).run();
            out.put("products", report.produtos);
            out.put("movements", report.movimentacoes);
        } catch (Exception ignored) {
            // segue sem contagens
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // Datas
    // -------------------------------------------------------------------------

    /** "há 2 h", "ontem"… a partir do ISO 8601 da API. */
    public static CharSequence relative(String iso) {
        long millis = parseIso(iso);
        if (millis <= 0) {
            return "";
        }
        return DateUtils.getRelativeTimeSpanString(millis, System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE);
    }

    public static long parseIso(String iso) {
        if (iso == null || iso.isEmpty()) {
            return 0L;
        }
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'"};
        for (String pattern : patterns) {
            try {
                SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
                format.setTimeZone(TimeZone.getTimeZone("UTC"));
                return format.parse(iso).getTime();
            } catch (ParseException | NullPointerException ignored) {
                // tenta o próximo
            }
        }
        return 0L;
    }
}
