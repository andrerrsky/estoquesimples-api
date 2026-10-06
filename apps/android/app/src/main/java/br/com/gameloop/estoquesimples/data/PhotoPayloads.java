package br.com.gameloop.estoquesimples.data;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Como a foto aparece no payload de produto enviado à nuvem.
 *
 * <ul>
 *   <li>chave {@code photoHash} <b>ausente</b>: a operação não mexeu na foto
 *       (é o que toda edição comum envia, e o que aparelhos antigos sempre
 *       enviaram) — nunca remove a foto do servidor;</li>
 *   <li>{@code photoHash: null}: remover a foto;</li>
 *   <li>{@code photoHash: "<sha256>"}: passar a usar essa imagem.</li>
 * </ul>
 * Quando a foto muda, {@code previous.photoHash} leva o valor de partida
 * (hash antigo ou {@code null}); sem isso o servidor não consegue mesclar uma
 * edição concorrente e a transforma em conflito pendente.
 */
public final class PhotoPayloads {

    public static final String FIELD = "photoHash";

    private PhotoPayloads() {
    }

    /** {@code previous} descreve uma mudança de foto? */
    public static boolean touchesPhoto(JSONObject previous) {
        return previous != null && previous.has(FIELD);
    }

    /** Põe {@code photoHash} (valor ou null) no payload. */
    public static void attach(JSONObject payload, String hashOrNull) {
        try {
            payload.put(FIELD, hashOrNull == null ? JSONObject.NULL : hashOrNull);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code previous} de uma mudança de foto: hash anterior ou null. */
    public static JSONObject previousFor(String previousHashOrNull) {
        JSONObject previous = new JSONObject();
        try {
            previous.put(FIELD, previousHashOrNull == null ? JSONObject.NULL : previousHashOrNull);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return previous;
    }

    /**
     * Ao compactar operações, o payload sobrevivente precisa continuar dizendo
     * o mesmo sobre a foto que o {@code previous} acumulado: se o acumulado
     * declara que a foto mudou mas o último payload não a traz, o servidor leria
     * a ausência como "remover". Copia o último valor visto.
     */
    public static void carryOver(JSONObject survivor, JSONObject mergedPrevious,
                                 boolean hasLastValue, Object lastValue) {
        if (!touchesPhoto(mergedPrevious) || survivor.has(FIELD) || !hasLastValue) {
            return;
        }
        try {
            survivor.put(FIELD, lastValue);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}
