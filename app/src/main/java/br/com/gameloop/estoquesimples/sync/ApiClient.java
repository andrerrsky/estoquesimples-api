package br.com.gameloop.estoquesimples.sync;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

import javax.net.ssl.HttpsURLConnection;

import br.com.gameloop.estoquesimples.BuildConfig;

/**
 * Cliente HTTP da API.
 *
 * Escrito sobre {@code HttpURLConnection} de propósito: uma biblioteca HTTP a
 * mais aumentaria o tamanho do APK para resolver um problema que aqui tem meia
 * dúzia de chamadas. O que importa
 * — tempo limite, um único ponto de tratamento de erro e recusa de conexão sem
 * TLS — está tudo abaixo.
 */
public final class ApiClient {

    private static final String TAG = "ApiClient";

    private static final int TIMEOUT_CONEXAO_MS = 15_000;
    private static final int TIMEOUT_LEITURA_MS = 30_000;

    private final String baseUrl;
    private final int protocolVersion;

    /** Diferença observada entre o relógio do aparelho e o do servidor. */
    private volatile long clockSkewMs;

    public ApiClient() {
        this(BuildConfig.API_BASE_URL, BuildConfig.SYNC_PROTOCOL);
    }

    public ApiClient(String baseUrl, int protocolVersion) {
        this.baseUrl = baseUrl.endsWith("/")
                ? baseUrl.substring(0, baseUrl.length() - 1)
                : baseUrl;
        this.protocolVersion = protocolVersion;
    }

    /** Resposta bruta: corpo já convertido e cabeçalhos que interessam. */
    public static final class Response {
        public final int statusCode;
        public final JSONObject body;

        Response(int statusCode, JSONObject body) {
            this.statusCode = statusCode;
            this.body = body;
        }
    }

    public long getClockSkewMs() {
        return clockSkewMs;
    }

    public Response get(String path, String accessToken) throws ApiException {
        return execute("GET", path, null, accessToken, null, TIMEOUT_LEITURA_MS);
    }

    /** GET de arquivo grande (cópia JSON da nuvem), com leitura mais longa. */
    public Response getLarge(String path, String accessToken) throws ApiException {
        return execute("GET", path, null, accessToken, null, 120_000);
    }

    public Response post(String path, JSONObject body, String accessToken) throws ApiException {
        return execute("POST", path, body, accessToken, null, TIMEOUT_LEITURA_MS);
    }

    /**
     * A API aceita PUT onde documenta PATCH justamente por causa deste
     * cliente: {@link HttpURLConnection} recusa PATCH com ProtocolException.
     */
    public Response put(String path, JSONObject body, String accessToken) throws ApiException {
        return execute("PUT", path, body, accessToken, null, TIMEOUT_LEITURA_MS);
    }

    public Response delete(String path, String accessToken) throws ApiException {
        return execute("DELETE", path, null, accessToken, null, TIMEOUT_LEITURA_MS);
    }

    /**
     * POST com chave de idempotência.
     *
     * Sem ela, uma resposta perdida no caminho de volta é indistinguível de uma
     * requisição que nunca chegou: o app tentaria de novo e o servidor aplicaria
     * a mesma operação duas vezes. Com a chave, o reenvio devolve o resultado
     * original.
     */
    public Response postIdempotent(String path, JSONObject body, String accessToken,
                                   String idempotencyKey) throws ApiException {
        return execute("POST", path, body, accessToken,
                idempotencyKey != null ? idempotencyKey : UUID.randomUUID().toString(),
                TIMEOUT_LEITURA_MS);
    }

    private Response execute(String method, String path, JSONObject body,
                             String accessToken, String idempotencyKey, int readTimeoutMs)
            throws ApiException {
        HttpURLConnection connection = null;
        Thread watchdog = null;
        try {
            URL url = new URL(baseUrl + path);
            Log.i(TAG, method + " " + url);
            connection = (HttpURLConnection) url.openConnection();

            // A API só é acessada por HTTPS. O app ainda permite tráfego em
            // texto claro para outros usos legados, e nada garante que uma
            // configuração errada não aponte a base para http://.
            if (!(connection instanceof HttpsURLConnection)) {
                throw new ApiException(0, "TLS_OBRIGATORIO",
                        "A sincronização exige uma conexão segura.", null);
            }

            connection.setRequestMethod(method);
            connection.setConnectTimeout(TIMEOUT_CONEXAO_MS);
            connection.setReadTimeout(readTimeoutMs);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Connection", "close");
            connection.setRequestProperty("X-Sync-Protocol", String.valueOf(protocolVersion));
            connection.setRequestProperty("X-App-Version", BuildConfig.VERSION_NAME);

            if (accessToken != null) {
                connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            }
            if (idempotencyKey != null) {
                connection.setRequestProperty("Idempotency-Key", idempotencyKey);
            }

            // Em HTTP/2 o timeout do HttpURLConnection às vezes é ignorado.
            // Cortar a conexão desbloqueia getResponseCode().
            final HttpURLConnection toWatch = connection;
            final int waitMs = TIMEOUT_CONEXAO_MS + readTimeoutMs + 5_000;
            watchdog = new Thread(() -> {
                try {
                    Thread.sleep(waitMs);
                    toWatch.disconnect();
                } catch (InterruptedException ignored) {
                    // Pedido terminou a tempo.
                }
            }, "api-watchdog");
            watchdog.setDaemon(true);
            watchdog.start();

            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(payload);
                }
            }

            int status = connection.getResponseCode();
            recordClockSkew(connection.getHeaderFieldDate("Date", 0L));

            String responseBody = readBody(connection, status);
            JSONObject json = parse(responseBody);

            if (status >= 200 && status < 300) {
                return new Response(status, json);
            }
            throw errorFrom(status, json, connection.getHeaderField("Retry-After"));

        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            Log.w(TAG, method + " " + path + " falhou: " + e.getMessage(), e);
            throw ApiException.network(e);
        } finally {
            if (watchdog != null) {
                watchdog.interrupt();
            }
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /**
     * O corpo do erro vem em {@code getErrorStream}, não em {@code getInputStream}.
     * Ler do fluxo errado descarta justamente a mensagem que explica a falha.
     */
    private String readBody(HttpURLConnection connection, int status) {
        InputStream stream = null;
        try {
            stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) {
                return null;
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString("UTF-8");
        } catch (IOException e) {
            return null;
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // Fechar o fluxo não pode mascarar o resultado da chamada.
                }
            }
        }
    }

    private JSONObject parse(String body) {
        if (body == null || body.trim().isEmpty()) {
            return new JSONObject();
        }
        try {
            return new JSONObject(body);
        } catch (JSONException e) {
            Log.w(TAG, "resposta não é um objeto JSON válido");
            return new JSONObject();
        }
    }

    private ApiException errorFrom(int status, JSONObject json, String retryAfterHeader) {
        JSONObject error = json.optJSONObject("error");
        String code = error != null ? error.optString("code", null) : null;
        String message = error != null ? error.optString("message", null) : null;

        Long retryAfter = null;
        if (error != null && error.has("retryAfterSeconds")) {
            retryAfter = error.optLong("retryAfterSeconds");
        } else if (retryAfterHeader != null) {
            try {
                retryAfter = Long.parseLong(retryAfterHeader.trim());
            } catch (NumberFormatException ignored) {
                // Retry-After também aceita data; nesse caso o backoff local decide.
            }
        }
        return new ApiException(status, code, message, retryAfter);
    }

    /**
     * Guarda a diferença entre os relógios.
     *
     * O horário do aparelho é usado apenas como informação nos registros — a
     * ordenação é sempre a do servidor. Ainda assim, um relógio muito errado
     * confunde o usuário ao ler o histórico, então a diferença é medida para
     * que a tela de status possa avisar.
     */
    private void recordClockSkew(long serverDateMs) {
        if (serverDateMs > 0) {
            clockSkewMs = System.currentTimeMillis() - serverDateMs;
        }
    }
}
