package br.com.gameloop.estoquesimples.changelog;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Lê {@code assets/changelog/releases.json}, a cópia da fonte única em
 * {@code packages/changelog} (a mesma que a web usa).
 *
 * Fica nos assets, e não na rede, porque a tela precisa abrir no avião e
 * porque a lista certa é a desta versão do app: quem está na 38 não deve ler
 * sobre uma tela que ainda não tem.
 */
public final class ChangelogLoader {

    private static final String TAG = "ChangelogLoader";
    private static final String ASSET = "changelog/releases.json";

    private ChangelogLoader() {
    }

    /** Da mais nova para a mais antiga; vazia se o arquivo faltar ou estiver torto. */
    public static List<Release> carregar(Context context) {
        List<Release> releases = new ArrayList<>();
        try {
            JSONObject raiz = new JSONObject(lerAsset(context));
            JSONArray lista = raiz.optJSONArray("releases");
            if (lista == null) {
                return releases;
            }
            for (int i = 0; i < lista.length(); i++) {
                JSONObject item = lista.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                releases.add(new Release(
                        item.optInt("version", 0),
                        item.optString("date", ""),
                        item.optString("title", ""),
                        textos(item.optJSONArray("highlights")),
                        textos(item.optJSONArray("fixes"))));
            }
            Collections.sort(releases, (a, b) -> Integer.compare(b.version, a.version));
        } catch (Exception e) {
            // Tela de novidades é conveniência: um arquivo torto não pode
            // derrubar o app na abertura do menu.
            Log.e(TAG, "não foi possível ler as novidades", e);
        }
        return releases;
    }

    private static List<String> textos(JSONArray array) {
        List<String> lista = new ArrayList<>();
        if (array == null) {
            return lista;
        }
        for (int i = 0; i < array.length(); i++) {
            Object valor = array.opt(i);
            if (valor instanceof String && !((String) valor).trim().isEmpty()) {
                lista.add(((String) valor).trim());
            }
        }
        return lista;
    }

    private static String lerAsset(Context context) throws IOException {
        try (InputStream in = context.getAssets().open(ASSET);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int lido;
            while ((lido = in.read(buf)) != -1) {
                out.write(buf, 0, lido);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
