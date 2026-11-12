package br.com.gameloop.estoquesimples.analytics;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.RemoteException;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * De onde veio esta instalação, segundo a Google Play (Install Referrer).
 *
 * A Play entrega, uma vez por instalação, a string de referência do link que
 * levou à loja: {@code utm_source=google-play&utm_medium=organic} para quem
 * achou o app na própria loja, as UTMs de um link nosso (site, Instagram) e,
 * nos anúncios do Google, também o identificador do clique ({@code gclid}).
 *
 * Guardamos só uma lista fechada de chaves, com as mesmas regras do cadastro
 * web na API ({@code signup-attribution.ts}): valores curtos, sem {@code @},
 * nada de e-mail ou URL. O resultado vai:
 *
 * <ul>
 *   <li>no evento {@code app.install_attributed}, uma vez por aparelho, sem o
 *       identificador do clique — mostra a origem das instalações mesmo de
 *       quem nunca cria conta;</li>
 *   <li>no cadastro ({@code POST /v1/auth/register}), para o painel mostrar
 *       a origem de cada conta.</li>
 * </ul>
 *
 * Sem rede nenhuma de terceiros: a consulta é ao serviço da Play no próprio
 * aparelho. Se a Play não responder, tenta de novo nas próximas aberturas
 * (até {@link #MAX_ATTEMPTS} vezes).
 */
public final class InstallAttribution {

    private static final String PREFS = "install_attribution";
    private static final String KEY_DONE = "done";
    private static final String KEY_ATTEMPTS = "attempts";
    private static final String KEY_JSON = "attribution";
    private static final int MAX_ATTEMPTS = 3;

    static final String[] UTM_KEYS = {"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"};
    static final String[] CLICK_KEYS = {"gclid", "gbraid", "wbraid"};

    private static final Pattern CLICK_ID = Pattern.compile("^[A-Za-z0-9_\\-.]{1,300}$");

    private static volatile boolean inFlight;

    private InstallAttribution() {}

    /** Consulta a Play uma única vez por instalação (chamado ao abrir o app). */
    public static void fetchOnce(Context context) {
        final Context app = context.getApplicationContext();
        final SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(KEY_DONE, false) || prefs.getInt(KEY_ATTEMPTS, 0) >= MAX_ATTEMPTS || inFlight) {
            return;
        }
        inFlight = true;
        prefs.edit().putInt(KEY_ATTEMPTS, prefs.getInt(KEY_ATTEMPTS, 0) + 1).apply();

        final InstallReferrerClient client;
        try {
            client = InstallReferrerClient.newBuilder(app).build();
        } catch (RuntimeException e) {
            inFlight = false;
            return;
        }
        try {
            client.startConnection(new InstallReferrerStateListener() {
                @Override
                public void onInstallReferrerSetupFinished(int responseCode) {
                    try {
                        if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                            ReferrerDetails details = client.getInstallReferrer();
                            store(app, prefs, parse(details.getInstallReferrer()));
                        } else if (responseCode == InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED) {
                            // Loja sem o serviço (aparelho sem Play, instalação manual): não há o que buscar.
                            prefs.edit().putBoolean(KEY_DONE, true).apply();
                        }
                    } catch (RemoteException | RuntimeException ignored) {
                        // Tenta de novo na próxima abertura.
                    } finally {
                        inFlight = false;
                        try {
                            client.endConnection();
                        } catch (RuntimeException ignored) {
                            // Conexão já encerrada.
                        }
                    }
                }

                @Override
                public void onInstallReferrerServiceDisconnected() {
                    inFlight = false;
                }
            });
        } catch (RuntimeException e) {
            inFlight = false;
        }
    }

    private static void store(Context context, SharedPreferences prefs, Map<String, String> values) {
        SharedPreferences.Editor editor = prefs.edit().putBoolean(KEY_DONE, true);
        if (!values.isEmpty()) {
            editor.putString(KEY_JSON, new JSONObject(values).toString());
        }
        editor.apply();
        if (values.isEmpty()) {
            return;
        }
        Map<String, Object> props = new LinkedHashMap<>();
        for (String key : new String[] {"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"}) {
            if (values.containsKey(key)) {
                props.put(key, values.get(key));
            }
        }
        props.put("has_click_id", hasClickId(values));
        Analytics.track(context, "app.install_attributed", props);
    }

    /**
     * Origem para o corpo do cadastro, ou {@code null} quando a Play não
     * informou nada útil (a API trata ausência como visita direta).
     */
    public static JSONObject forSignup(Context context) {
        String raw = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_JSON, null);
        if (raw == null) {
            return null;
        }
        try {
            JSONObject json = new JSONObject(raw);
            return json.length() == 0 ? null : json;
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * Lê a string de referência da Play e devolve só as chaves aceitas, já
     * validadas. Chaves desconhecidas (anid, aclid…) e valores fora do
     * formato são descartados em silêncio.
     */
    static Map<String, String> parse(String referrer) {
        Map<String, String> out = new LinkedHashMap<>();
        if (referrer == null || referrer.trim().isEmpty()) {
            return out;
        }
        for (String pair : referrer.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = decode(pair.substring(0, eq)).trim();
            String value = decode(pair.substring(eq + 1)).trim();
            if (value.isEmpty() || out.containsKey(key)) {
                continue;
            }
            if (contains(UTM_KEYS, key)) {
                if (value.length() <= 150 && !value.contains("@")) {
                    out.put(key, value);
                }
            } else if (contains(CLICK_KEYS, key)) {
                if (CLICK_ID.matcher(value).matches()) {
                    out.put(key, value);
                }
            }
        }
        // A API só grava quando há campanha (UTM ou clique); sem isso, nada a guardar.
        return out;
    }

    static boolean hasClickId(Map<String, String> values) {
        for (String key : CLICK_KEYS) {
            if (values.containsKey(key)) {
                return true;
            }
        }
        return false;
    }

    private static boolean contains(String[] keys, String key) {
        for (String candidate : keys) {
            if (candidate.equals(key)) {
                return true;
            }
        }
        return false;
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return value;
        }
    }
}
