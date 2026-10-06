package br.com.gameloop.estoquesimples.photos;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;

/**
 * Regras puras da sincronização de fotos, sem Android nem rede.
 *
 * Ficam separadas para poderem ser testadas na JVM: as decisões de "sobe,
 * baixa ou mantém" são justamente as que não podem errar, porque um erro aqui
 * ou apaga a foto de alguém ou a troca por outra.
 *
 * <p>Estado local de uma foto, em duas colunas de {@code Estoque}:
 * <ul>
 *   <li>{@code photo != vazio && photo_hash == null}: a foto local ainda
 *       precisa subir;</li>
 *   <li>{@code photo_hash != null}: o arquivo local corresponde a essa imagem
 *       da nuvem (se o arquivo sumiu, é preciso baixar de novo).</li>
 * </ul>
 */
public final class PhotoRules {

    /** Tamanho máximo que a API aceita no envio (2 MiB). */
    public static final int MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

    private static final Pattern HASH = Pattern.compile("^[0-9a-f]{64}$");

    private PhotoRules() {
    }

    /** O que fazer com a foto de um produto que chegou da nuvem. */
    public enum PullDecision {
        /** Nada a fazer (mesma imagem, ou servidor antigo que não informa foto). */
        NOTHING,
        /** Passa a usar a imagem do servidor (baixa se faltar o arquivo). */
        ADOPT_SERVER,
        /** A foto local ainda vai subir; ela vence ou perde pelo envio normal. */
        KEEP_LOCAL,
        /** O servidor não tem foto e a local já tinha sido sincronizada: remove. */
        REMOVE_LOCAL
    }

    public static boolean isEmptyPath(String path) {
        return path == null || path.isEmpty() || "null".equals(path);
    }

    public static boolean isValidHash(String hash) {
        return hash != null && HASH.matcher(hash).matches();
    }

    /** Há foto local que a nuvem ainda não conhece. */
    public static boolean needsUpload(String photo, String photoHash) {
        return !isEmptyPath(photo) && photoHash == null;
    }

    /**
     * A nuvem tem uma imagem para este produto e o arquivo local não existe.
     * É o marcador que a rodada seguinte usa para tentar baixar de novo.
     */
    public static boolean needsDownload(String photoHash, boolean localFileExists) {
        return photoHash != null && !localFileExists;
    }

    /**
     * Decide o que fazer ao aplicar um produto recebido.
     *
     * @param serverHasField   o JSON do produto traz a chave {@code photoHash}
     *                         (servidor sem o recurso não traz: não mexe)
     * @param serverHash       valor recebido; nulo = produto sem foto
     * @param localPhoto       caminho local da foto
     * @param localHash        {@code photo_hash} local
     */
    public static PullDecision decidePull(boolean serverHasField, String serverHash,
                                          String localPhoto, String localHash) {
        if (!serverHasField) {
            return PullDecision.NOTHING;
        }
        // Foto trocada/criada aqui e ainda não enviada: o envio decide.
        if (needsUpload(localPhoto, localHash)) {
            return PullDecision.KEEP_LOCAL;
        }
        if (serverHash == null) {
            return localHash != null ? PullDecision.REMOVE_LOCAL : PullDecision.NOTHING;
        }
        if (!isValidHash(serverHash)) {
            return PullDecision.NOTHING;
        }
        if (serverHash.equals(localHash)) {
            return PullDecision.NOTHING;
        }
        return PullDecision.ADOPT_SERVER;
    }

    /** Nome do arquivo local de uma imagem baixada. */
    public static String canonicalName(String hash) {
        return hash + ".webp";
    }

    /**
     * Falhas do envio que não vão melhorar repetindo com o mesmo arquivo.
     * 413/415/422 são do arquivo; o resto (cota, permissão, rede, 5xx) é do
     * momento e o arquivo continua no aparelho para a próxima rodada.
     */
    public static boolean isPermanentUploadFailure(int statusCode, String code) {
        return statusCode == 413 || statusCode == 415 || statusCode == 422
                || "IMAGE_UNSUPPORTED_TYPE".equals(code) || "IMAGE_INVALID".equals(code)
                || "PAYLOAD_TOO_LARGE".equals(code);
    }

    // -------------------------------------------------------------------------
    // Hash
    // -------------------------------------------------------------------------

    public static String sha256Hex(byte[] data) {
        MessageDigest digest = digest();
        return toHex(digest.digest(data));
    }

    public static String sha256Hex(InputStream in) throws IOException {
        MessageDigest digest = digest();
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = in.read(buffer)) != -1) {
            digest.update(buffer, 0, read);
        }
        return toHex(digest.digest());
    }

    /** Os bytes baixados são mesmo a imagem pedida? */
    public static boolean matchesHash(byte[] data, String expectedHash) {
        return data != null && isValidHash(expectedHash)
                && expectedHash.equals(sha256Hex(data));
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String toHex(byte[] bytes) {
        char[] hex = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int v = bytes[i] & 0xff;
            out[i * 2] = hex[v >>> 4];
            out[i * 2 + 1] = hex[v & 0x0f];
        }
        return new String(out);
    }
}
