package br.com.gameloop.estoquesimples.branding;

import android.graphics.Color;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

import br.com.gameloop.estoquesimples.R;

/**
 * Identidade visual de uma empresa, como a API a entrega em
 * {@code entitlement.branding}. É só um conjunto de cores, uma fonte e o
 * endereço de um logotipo: o app inteiro continua sendo o mesmo, com as mesmas
 * telas e fluxos, e estas cores entram no lugar das do tema por recurso.
 *
 * Imutável. Quem decide se existe uma marca ativa é o servidor; qualquer
 * dado inválido aqui resulta em {@code null} (visual padrão), nunca em erro.
 */
public final class Brand {

    private static final Pattern HEX = Pattern.compile("^#[0-9a-fA-F]{6}$");

    public final String slug;
    public final String displayName;
    public final int version;
    public final int primary;
    public final int primaryDark;
    public final int primaryPressed;
    public final int onPrimary;
    public final int accent;
    public final int text;
    public final int textMuted;
    public final boolean serif;
    /** Caminho relativo da API ({@code /v1/public/brand/<slug>/logo?v=<hash>}), ou null. */
    public final String logoUrl;
    /** Hash do logotipo (nome do arquivo em cache), ou null. */
    public final String logoHash;

    private Brand(String slug, String displayName, int version, int[] c, boolean serif,
                  String logoUrl, String logoHash) {
        this.slug = slug;
        this.displayName = displayName;
        this.version = version;
        this.primary = c[0];
        this.primaryDark = c[1];
        this.primaryPressed = c[2];
        this.onPrimary = c[3];
        this.accent = c[4];
        this.text = c[5];
        this.textMuted = c[6];
        this.serif = serif;
        this.logoUrl = logoUrl;
        this.logoHash = logoHash;
    }

    /** Lê o objeto {@code branding}; {@code null} se não está ativo ou algo não confere. */
    public static Brand fromJson(JSONObject json) {
        if (json == null || !json.optBoolean("active", false)) {
            return null;
        }
        JSONObject theme = json.optJSONObject("theme");
        String slug = json.isNull("slug") ? null : json.optString("slug", null);
        if (theme == null || slug == null || slug.isEmpty()) {
            return null;
        }
        String[] keys = {"primary", "primaryDark", "primaryPressed", "onPrimary", "accent", "text", "textMuted"};
        int[] colors = new int[keys.length];
        for (int i = 0; i < keys.length; i++) {
            String hex = theme.optString(keys[i], "");
            if (!HEX.matcher(hex).matches()) {
                return null;
            }
            colors[i] = Color.parseColor(hex);
        }
        JSONObject logo = json.optJSONObject("logo");
        String logoUrl = null;
        String logoHash = null;
        if (logo != null) {
            String url = logo.optString("url", "");
            String hash = logo.optString("hash", "");
            // Só aceita caminho da própria API e hash no formato esperado.
            if (url.startsWith("/v1/public/brand/") && hash.matches("^[0-9a-f]{64}$")) {
                logoUrl = url;
                logoHash = hash;
            }
        }
        String name = json.isNull("displayName") ? null : json.optString("displayName", null);
        return new Brand(slug, name, json.optInt("version", 0), colors,
                "serif".equals(theme.optString("font")), logoUrl, logoHash);
    }

    /** Cores do tema do app que a marca substitui (recurso -> cor). */
    public Map<Integer, Integer> colorOverrides() {
        Map<Integer, Integer> map = new HashMap<>();
        map.put(R.color.color_brand, primary);
        map.put(R.color.color_brand_dark, primaryDark);
        map.put(R.color.color_brand_pressed, primaryPressed);
        map.put(R.color.color_text_on_brand, onPrimary);
        map.put(R.color.color_ripple_brand, (primary & 0x00FFFFFF) | 0x33000000);
        map.put(R.color.color_accent, accent);
        map.put(R.color.color_text, text);
        map.put(R.color.color_text_muted, textMuted);
        // Apelidos do tema: apontam para a cor principal, mas a sobreposição por
        // recurso só vale se cada um for substituído também.
        map.put(R.color.colorPrimary, primary);
        map.put(R.color.colorPrimaryDark, primaryDark);
        map.put(R.color.colorAccent, primary);
        map.put(R.color.colorActionBar, primary);
        map.put(R.color.system_bar, primary);
        return map;
    }
}
