package br.com.gameloop.estoquesimples.branding;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.ColorRes;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Última identidade visual recebida do servidor, guardada para o app abrir já
 * com ela (e funcionar offline). Não é segredo e adulterá-la não concede
 * nada: é só aparência.
 *
 * Vale pelo mesmo prazo do retrato de direitos ({@code offlineValidUntil}):
 * se o aparelho ficar sem falar com a API além disso, volta ao visual
 * padrão — a assinatura pode ter acabado nesse meio-tempo.
 */
public final class BrandStore {

    private static final String ARQUIVO = "estoque_marca";
    private static final String CHAVE_JSON = "branding";
    private static final String CHAVE_VALIDO_ATE = "valido_ate";

    private static volatile Brand cache;
    private static volatile boolean carregado;

    private BrandStore() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE);
    }

    /** Marca em vigor agora, ou {@code null} = visual padrão do Estoque Simples. */
    @Nullable
    public static Brand current(Context context) {
        SharedPreferences prefs = prefs(context);
        if (System.currentTimeMillis() >= prefs.getLong(CHAVE_VALIDO_ATE, 0L)) {
            return null;
        }
        if (!carregado) {
            synchronized (BrandStore.class) {
                if (!carregado) {
                    cache = parse(prefs.getString(CHAVE_JSON, null));
                    carregado = true;
                }
            }
        }
        return cache;
    }

    /**
     * Guarda o retrato recebido (o corpo inteiro do entitlement). Sem
     * {@code branding} ativo, apaga: foi assim que o servidor disse "visual padrão".
     */
    public static void save(Context context, JSONObject entitlement, long validUntilMillis) {
        JSONObject branding = entitlement == null ? null : entitlement.optJSONObject("branding");
        Brand brand = Brand.fromJson(branding);
        SharedPreferences.Editor editor = prefs(context).edit();
        if (brand == null) {
            editor.clear();
        } else {
            editor.putString(CHAVE_JSON, branding.toString()).putLong(CHAVE_VALIDO_ATE, validUntilMillis);
        }
        editor.apply();
        synchronized (BrandStore.class) {
            cache = brand;
            carregado = true;
        }
        if (brand == null) {
            BrandLogo.clear(context);
        }
    }

    /** Sair da conta ou trocar de empresa: nada da empresa anterior fica. */
    public static void clear(Context context) {
        prefs(context).edit().clear().apply();
        synchronized (BrandStore.class) {
            cache = null;
            carregado = true;
        }
        BrandLogo.clear(context);
    }

    @Nullable
    private static Brand parse(@Nullable String json) {
        if (json == null) {
            return null;
        }
        try {
            return Brand.fromJson(new JSONObject(json));
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * Cor de um recurso do tema já com a marca aplicada. Serve ao código
     * (notificações, barras do sistema) que não passa pela sobreposição de
     * recursos — que só existe a partir do Android 11.
     */
    public static int color(Context context, @ColorRes int resId) {
        Brand brand = current(context);
        if (brand != null) {
            Integer override = brand.colorOverrides().get(resId);
            if (override != null) {
                return override;
            }
        }
        return ContextCompat.getColor(context, resId);
    }
}
