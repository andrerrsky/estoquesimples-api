package br.com.gameloop.estoquesimples.analytics;

import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import com.google.firebase.analytics.FirebaseAnalytics;

import java.util.HashMap;
import java.util.Map;

/**
 * Espelha os eventos do analytics próprio no Firebase Analytics (Google
 * Analytics 4 do app), para o app aparecer junto com o site nos relatórios
 * do Google. O Firebase já registra sozinho primeira abertura, sessões, telas
 * e atualizações; aqui entram os eventos de produto (produto criado,
 * movimentação, exportação, assinatura…).
 *
 * Mesmas regras do analytics próprio: só nomes e contagens, nunca e-mail,
 * nome de produto ou valores. O identificador de publicidade continua
 * desligado no manifesto.
 */
public final class FirebaseMirror {

    private static final String TAG = "FirebaseMirror";

    /** Eventos que também viram o evento recomendado do GA4. */
    private static final Map<String, String> RECOMENDADOS = new HashMap<>();

    static {
        RECOMENDADOS.put("purchase.started", FirebaseAnalytics.Event.BEGIN_CHECKOUT);
        RECOMENDADOS.put("search.performed", FirebaseAnalytics.Event.SEARCH);
        RECOMENDADOS.put("help.searched", FirebaseAnalytics.Event.SEARCH);
        RECOMENDADOS.put("auth.login", FirebaseAnalytics.Event.LOGIN);
        RECOMENDADOS.put("signup.completed", FirebaseAnalytics.Event.SIGN_UP);
    }

    private FirebaseMirror() {
    }

    public static void log(Context context, String name, Map<String, Object> props) {
        // A tela o Firebase já mede sozinho (screen_view): repetir duplicaria.
        if ("screen.viewed".equals(name)) {
            return;
        }
        try {
            FirebaseAnalytics analytics = FirebaseAnalytics.getInstance(context);
            Bundle bundle = toBundle(props);
            analytics.logEvent(gaName(name), bundle);
            String recomendado = RECOMENDADOS.get(name);
            if (recomendado != null) {
                analytics.logEvent(recomendado, bundle);
            }
        } catch (Exception e) {
            Log.w(TAG, "evento não espelhado: " + name, e);
        }
    }

    /** "product.created" → "product_created": o GA4 aceita letras, números e "_", até 40. */
    static String gaName(String name) {
        String clean = name.replaceAll("[^A-Za-z0-9_]", "_");
        if (!clean.isEmpty() && Character.isDigit(clean.charAt(0))) {
            clean = "e_" + clean;
        }
        return clean.length() > 40 ? clean.substring(0, 40) : clean;
    }

    private static Bundle toBundle(Map<String, Object> props) {
        Bundle bundle = new Bundle();
        if (props == null) {
            return bundle;
        }
        int count = 0;
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            if (count++ >= 25 || entry.getKey() == null) {
                break;
            }
            String key = gaName(entry.getKey());
            Object value = entry.getValue();
            if (value instanceof Integer || value instanceof Long) {
                bundle.putLong(key, ((Number) value).longValue());
            } else if (value instanceof Number) {
                bundle.putDouble(key, ((Number) value).doubleValue());
            } else if (value instanceof Boolean) {
                bundle.putString(key, value.toString());
            } else if (value != null) {
                String text = value.toString();
                bundle.putString(key, text.length() > 100 ? text.substring(0, 100) : text);
            }
        }
        return bundle;
    }
}
