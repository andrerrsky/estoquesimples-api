package br.com.gameloop.estoquesimples.diagnostics;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import br.com.gameloop.estoquesimples.BuildConfig;
import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Registro de erros do app, enviado para a API ({@code POST /v1/client-errors})
 * e visto no painel em Admin › Erros, junto com os da API e da web.
 *
 * <ul>
 *   <li>Falha que fecha o app: gravada em arquivo no instante da queda (sem
 *       rede, sem thread nova) e enviada na próxima abertura.</li>
 *   <li>Respostas 5xx da API e erros inesperados da sincronização: entram na
 *       mesma fila e saem em segundo plano.</li>
 * </ul>
 *
 * Nada aqui pode causar outro erro: tudo é melhor esforço. A fila tem teto
 * (30 itens) e cada envio leva no máximo 20. Nunca entra conteúdo do estoque
 * nem dados digitados; a API ainda limpa e-mails e tokens das mensagens.
 */
public final class ErrorReporter {

    private static final String TAG = "ErrorReporter";
    private static final String FILE = "erros-pendentes.json";
    private static final int MAX_PENDING = 30;
    private static final Pattern UUID = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", Pattern.CASE_INSENSITIVE);

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static volatile Context app;
    private static volatile boolean installed;

    private ErrorReporter() {
    }

    /** Chamar uma vez, no início do app. Envia o que ficou da última abertura. */
    public static synchronized void install(Context context) {
        app = context.getApplicationContext();
        if (installed) {
            return;
        }
        installed = true;
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                // Síncrono e curto: o processo vai morrer logo em seguida.
                append(event("fatal", "crash", error.getClass().getSimpleName(),
                        error.getClass().getName() + ": " + error.getMessage(), stackOf(error),
                        null, 0, null, "thread " + thread.getName()));
            } catch (Throwable ignored) {
                // nada a fazer: segue para o tratamento padrão do sistema
            }
            if (previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
        flushAsync();
    }

    /** Exceção inesperada (sincronização, tela). */
    public static void report(String kind, Throwable error) {
        if (error == null) {
            return;
        }
        enqueue(event("error", kind, error.getClass().getSimpleName(),
                error.getClass().getName() + ": " + error.getMessage(), stackOf(error),
                null, 0, null, null));
    }

    /** Resposta 5xx da API: guarda o código para cruzar com o registro do servidor. */
    public static void reportApi(String method, String path, int status, String code, String message,
                                 String correlationId) {
        String endpoint = path == null ? null : UUID.matcher(path.split("\\?")[0]).replaceAll(":id");
        enqueue(event("error", "api", code, status + " " + code + ": " + message, null,
                method + " " + endpoint, status, correlationId, null));
    }

    private static JSONObject event(String level, String kind, String code, String message, String stack,
                                    String route, int status, String correlationId, String extra) {
        JSONObject json = new JSONObject();
        try {
            json.put("source", "android");
            json.put("level", level);
            json.put("kind", kind);
            if (code != null) json.put("code", truncate(code, 80));
            json.put("message", truncate(message == null ? "(sem mensagem)" : message, 2000));
            if (stack != null) json.put("stack", truncate(stack, 16000));
            if (route != null) json.put("route", truncate(route, 300));
            if (status > 0) json.put("status", status);
            if (correlationId != null) json.put("correlationId", truncate(correlationId, 80));
            json.put("appVersion", BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")");
            json.put("platform", "Android " + Build.VERSION.RELEASE + " · " + Build.MANUFACTURER + " " + Build.MODEL);
            json.put("occurredAt", System.currentTimeMillis());
            Context context = app;
            if (context != null) {
                String workspace = SessionManager.get(context).workspaceId();
                if (workspace != null && UUID.matcher(workspace).matches()) json.put("workspaceId", workspace);
            }
            if (extra != null) {
                json.put("context", new JSONObject().put("detalhe", truncate(extra, 300)));
            }
        } catch (Exception ignored) {
            // um campo a menos não impede o registro
        }
        return json;
    }

    private static void enqueue(JSONObject event) {
        if (app == null) {
            return;
        }
        EXECUTOR.execute(() -> {
            append(event);
            send();
        });
    }

    /** Envia o que estiver na fila (abertura do app, fim da sincronização). */
    public static void flushAsync() {
        if (app == null) {
            return;
        }
        EXECUTOR.execute(ErrorReporter::send);
    }

    private static synchronized void append(JSONObject event) {
        try {
            JSONArray pending = read();
            if (pending.length() >= MAX_PENDING) {
                return; // fila cheia: o que já está lá basta para investigar
            }
            pending.put(event);
            write(pending);
        } catch (Exception e) {
            Log.w(TAG, "não foi possível guardar o erro", e);
        }
    }

    private static void send() {
        Context context = app;
        if (context == null) {
            return;
        }
        JSONArray pending;
        synchronized (ErrorReporter.class) {
            pending = read();
        }
        if (pending.length() == 0) {
            return;
        }
        JSONArray lote = new JSONArray();
        for (int i = 0; i < Math.min(20, pending.length()); i++) {
            lote.put(pending.opt(i));
        }
        String token = null;
        try {
            SessionManager session = SessionManager.get(context);
            if (session.isSignedIn()) {
                token = session.accessToken();
            }
        } catch (Exception ignored) {
            // sem sessão válida o erro vai sem a pessoa
        }
        try {
            new ApiClient().postWithoutReporting("/v1/client-errors",
                    new JSONObject().put("errors", lote), token);
            synchronized (ErrorReporter.class) {
                JSONArray atual = read();
                JSONArray resto = new JSONArray();
                for (int i = lote.length(); i < atual.length(); i++) {
                    resto.put(atual.opt(i));
                }
                write(resto);
            }
        } catch (Exception e) {
            // Sem rede ou API fora: fica para a próxima vez.
            Log.i(TAG, "erros não enviados agora: " + e.getMessage());
        }
    }

    private static File file() {
        return new File(app.getFilesDir(), FILE);
    }

    private static JSONArray read() {
        try {
            File file = file();
            if (!file.isFile()) {
                return new JSONArray();
            }
            return new JSONArray(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static void write(JSONArray pending) {
        try (FileOutputStream out = new FileOutputStream(file())) {
            out.write(pending.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "não foi possível gravar a fila de erros", e);
        }
    }

    private static String stackOf(Throwable error) {
        StringWriter writer = new StringWriter();
        error.printStackTrace(new PrintWriter(writer));
        return writer.toString();
    }

    private static String truncate(String value, int max) {
        return value.length() > max ? value.substring(0, max) + "…" : value;
    }
}
