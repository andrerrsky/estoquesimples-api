package br.com.gameloop.estoquesimples.help;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Lê {@code assets/help/faq.json} e monta o {@link HelpContent}.
 *
 * O arquivo é CÓPIA de {@code packages/help/faq.json} (raiz do monorepo),
 * gerada por {@code npm run help:sync}; não se edita aqui.
 *
 * A leitura é síncrona e pode rodar na thread principal: são ~35 KB de JSON
 * local — medido no emulador, 1 a 4 ms entre abrir o arquivo e ter os
 * artigos, bem menos do que inflar o layout da tela — e o resultado fica
 * guardado enquanto o processo vive. Em troca, a tela nasce pronta: sem
 * estado de "carregando" e com a posição da lista e os artigos abertos
 * restaurados na rotação sem corrida com outra thread. O que pesa de
 * verdade (normalizar o texto para a busca, 10 a 20 ms) sai da thread
 * principal: ver {@link HelpContent#prepareSearch()}.
 */
public final class HelpLoader {

    private static final String TAG = "HelpLoader";
    private static final String ASSET = "help/faq.json";

    private static HelpContent cache;

    private HelpLoader() {
    }

    /**
     * Conteúdo da ajuda, ou {@code null} se o arquivo faltar ou vier
     * corrompido — quem chama mostra o caminho para o suporte no lugar.
     */
    public static synchronized HelpContent load(Context context) {
        if (cache != null) {
            return cache;
        }
        try {
            final HelpContent content = parse(lerAsset(context.getApplicationContext()));
            if (content.articles.isEmpty()) {
                Log.w(TAG, "ajuda sem nenhum artigo para o aplicativo");
                return null;
            }
            cache = content;
            // A parte cara não é ler o arquivo, é tirar acento de todo o
            // texto para a busca. Isso se adianta em segundo plano, para a
            // primeira tecla digitada não pagar a conta.
            Thread aquecimento = new Thread(new Runnable() {
                @Override
                public void run() {
                    content.prepareSearch();
                }
            }, "help-search-warmup");
            aquecimento.setPriority(Thread.MIN_PRIORITY);
            aquecimento.start();
            return content;
        } catch (Exception e) {
            Log.w(TAG, "falha ao ler " + ASSET, e);
            return null;
        }
    }

    /**
     * Campos desconhecidos são ignorados (o arquivo pode ganhar campos que
     * só a web usa) e um artigo incompleto é pulado sem derrubar os outros.
     */
    static HelpContent parse(String json) throws JSONException {
        JSONObject raiz = new JSONObject(json);

        List<HelpContent.Category> categorias = new ArrayList<>();
        JSONArray listaCategorias = raiz.getJSONArray("categories");
        for (int i = 0; i < listaCategorias.length(); i++) {
            JSONObject item = listaCategorias.optJSONObject(i);
            if (item == null) {
                continue;
            }
            String id = item.optString("id", "");
            String titulo = item.optString("title", "");
            if (id.isEmpty() || titulo.isEmpty()) {
                continue;
            }
            categorias.add(new HelpContent.Category(id, titulo, item.optString("summary", "")));
        }

        List<HelpContent.Article> artigos = new ArrayList<>();
        JSONArray listaArtigos = raiz.getJSONArray("articles");
        for (int i = 0; i < listaArtigos.length(); i++) {
            JSONObject item = listaArtigos.optJSONObject(i);
            if (item == null) {
                continue;
            }
            String id = item.optString("id", "");
            String pergunta = item.optString("question", "");
            List<String> resposta = textos(item.optJSONArray("answer"));
            if (id.isEmpty() || pergunta.isEmpty() || resposta.isEmpty()) {
                continue;
            }
            artigos.add(new HelpContent.Article(
                    id,
                    item.optString("category", ""),
                    pergunta,
                    resposta,
                    textos(item.optJSONArray("keywords")),
                    // Ausente = todas as plataformas; lista vazia = nenhuma.
                    item.has("platforms") ? textos(item.optJSONArray("platforms")) : null));
        }
        return new HelpContent(categorias, artigos);
    }

    private static List<String> textos(JSONArray array) {
        List<String> lista = new ArrayList<>();
        if (array == null) {
            return lista;
        }
        for (int i = 0; i < array.length(); i++) {
            Object valor = array.opt(i);
            if (valor instanceof String && !((String) valor).isEmpty()) {
                lista.add((String) valor);
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
