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
    /** Uma repetição depois da primeira falha de rede, sem contar erro do servidor. */
    private static final int TENTATIVAS = 2;
    private static final int PAUSA_ENTRE_TENTATIVAS_MS = 800;

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
        /** Corpo binário (só nas chamadas de arquivo); nulo nas demais. */
        public final byte[] bytes;

        Response(int statusCode, JSONObject body) {
            this(statusCode, body, null);
        }

        Response(int statusCode, JSONObject body, byte[] bytes) {
            this.statusCode = statusCode;
            this.body = body;
            this.bytes = bytes;
        }
    }

    /**
     * Transferência de arquivo: corpo bruto no envio e/ou resposta binária.
     * Existe à parte para o caminho JSON, que é o de todas as outras chamadas,
     * continuar exatamente como era.
     */
    private static final class Binary {
        final byte[] upload;
        final String uploadContentType;
        final boolean download;
        final int maxDownloadBytes;

        Binary(byte[] upload, String uploadContentType, boolean download, int maxDownloadBytes) {
            this.upload = upload;
            this.uploadContentType = uploadContentType;
            this.download = download;
            this.maxDownloadBytes = maxDownloadBytes;
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
     * PUT de um arquivo (imagem de produto). A resposta é JSON. Repetir o mesmo
     * arquivo é seguro: a API devolve a mesma imagem.
     */
    public Response putFile(String path, String contentType, byte[] bytes, String accessToken)
            throws ApiException {
        return execute("PUT", path, null, accessToken, null, 60_000,
                new Binary(bytes, contentType, false, 0));
    }

    /** GET de um arquivo; {@link Response#bytes} traz o conteúdo (limitado a {@code maxBytes}). */
    public Response getFile(String path, String accessToken, int maxBytes) throws ApiException {
        return execute("GET", path, null, accessToken, null, 60_000,
                new Binary(null, null, true, maxBytes));
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

    /**
     * Duas tentativas só quando a chamada não chega a ter resposta HTTP.
     *
     * Senha errada, 401 e 403 já são uma resposta: repetir não muda o resultado
     * e, num POST, poderia aplicar a operação duas vezes. A chave de
     * idempotência, quando existe, é a mesma nas duas tentativas.
     */
    private Response execute(String method, String path, JSONObject body,
                             String accessToken, String idempotencyKey, int readTimeoutMs)
            throws ApiException {
        return execute(method, path, body, accessToken, idempotencyKey, readTimeoutMs, null);
    }

    private Response execute(String method, String path, JSONObject body,
                             String accessToken, String idempotencyKey, int readTimeoutMs,
                             Binary binary)
            throws ApiException {
        ApiException ultima = null;
        for (int tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
            try {
                return executeOnce(method, path, body, accessToken, idempotencyKey, readTimeoutMs,
                        binary);
            } catch (ApiException e) {
                ultima = e;
                boolean rede = ApiException.SEM_REDE.equals(e.getCode());
                if (!rede || tentativa == TENTATIVAS) {
                    throw e;
                }
                Log.i(TAG, method + " " + path + " sem resposta; nova tentativa");
                try {
                    Thread.sleep(PAUSA_ENTRE_TENTATIVAS_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
        throw ultima;
    }

    private Response executeOnce(String method, String path, JSONObject body,
                                 String accessToken, String idempotencyKey, int readTimeoutMs,
                                 Binary binary)
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

            if (binary != null && binary.upload != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", binary.uploadContentType);
                connection.setFixedLengthStreamingMode(binary.upload.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(binary.upload);
                }
            } else if (body != null) {
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

            if (binary != null && binary.download && status >= 200 && status < 300) {
                return new Response(status, new JSONObject(),
                        readBytes(connection, binary.maxDownloadBytes));
            }

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

    /** Lê o corpo binário inteiro, recusando o que passar do limite. */
    private byte[] readBytes(HttpURLConnection connection, int maxBytes) throws IOException {
        try (InputStream stream = connection.getInputStream()) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                if (buffer.size() + read > maxBytes) {
                    throw new IOException("resposta maior que o limite de " + maxBytes + " bytes");
                }
                buffer.write(chunk, 0, read);
            }
            return buffer.toByteArray();
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
