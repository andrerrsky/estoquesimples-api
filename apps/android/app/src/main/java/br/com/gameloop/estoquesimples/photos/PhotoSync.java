package br.com.gameloop.estoquesimples.photos;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import br.com.gameloop.estoquesimples.PhotoPathHelper;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.ProductRepository;
import br.com.gameloop.estoquesimples.data.SyncMeta;
import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.Interrupcao;
import br.com.gameloop.estoquesimples.sync.SessionManager;

/**
 * Fotos dos produtos dentro do ciclo de sincronização.
 *
 * <ul>
 *   <li>{@link #uploadPending()} roda <b>antes</b> do envio da fila: a nuvem
 *       ignora um {@code photoHash} cuja imagem ela não tem, então a imagem
 *       precisa chegar primeiro. Cada upload bem-sucedido grava o hash e
 *       enfileira uma edição normal do produto.</li>
 *   <li>{@link #downloadMissing()} roda <b>depois</b> da leitura: baixa o que a
 *       nuvem apontou e ainda não está no aparelho.</li>
 * </ul>
 *
 * Nenhum dos dois lança erro de API: foto nunca pode travar nem falhar a
 * sincronização do estoque. O que não deu fica no aparelho e é tentado de novo
 * na rodada seguinte.
 */
public final class PhotoSync {

    private static final String TAG = "PhotoSync";

    /** Trabalho por rodada, para uma fila grande de fotos não monopolizar o worker. */
    public static final int MAX_UPLOADS_PER_CYCLE = 20;
    public static final int MAX_DOWNLOADS_PER_CYCLE = 20;
    /** Teto do que se aceita baixar (o servidor guarda no máximo ~1280 px). */
    static final int MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
    /** Espera antes de tentar de novo uma imagem que a nuvem disse não ter. */
    static final long NOT_FOUND_RETRY_MS = 60 * 60 * 1000L;

    private static final String META_IGNORAR = "foto_ignorar:";
    private static final String META_ADIAR = "foto_adiar:";

    private final Context context;
    private final SQLiteDatabase db;
    private final ApiClient api;
    private final SessionManager session;
    private final Interrupcao interrupcao;
    private final SyncMeta meta;

    public PhotoSync(Context context, SQLiteDatabase db, ApiClient api, SessionManager session,
                     Interrupcao interrupcao) {
        this.context = context.getApplicationContext();
        this.db = db;
        this.api = api;
        this.session = session;
        this.interrupcao = interrupcao;
        this.meta = new SyncMeta(db);
    }

    private boolean parar() {
        return interrupcao != null && interrupcao.pediuParada();
    }

    // -------------------------------------------------------------------------
    // Envio
    // -------------------------------------------------------------------------

    /** Candidata ao envio: produto vivo com foto local sem hash. */
    private static final class Candidata {
        final String uuid;
        final String caminho;

        Candidata(String uuid, String caminho) {
            this.uuid = uuid;
            this.caminho = caminho;
        }
    }

    /** @return quantas fotos subiram nesta rodada. */
    public int uploadPending() {
        String workspaceId = session.workspaceId();
        if (workspaceId == null) {
            return 0;
        }
        List<Candidata> candidatas = candidatas();
        if (candidatas.isEmpty()) {
            meta.remove(SyncMeta.FOTOS_AVISO);
            return 0;
        }

        ProductRepository products = new ProductRepository(db);
        int enviadas = 0;
        int tentativas = 0;
        boolean bloqueada = false;

        for (Candidata candidata : candidatas) {
            if (parar() || tentativas >= MAX_UPLOADS_PER_CYCLE) {
                break;
            }
            String impressao = fingerprint(candidata.caminho);
            if (impressao == null) {
                continue; // arquivo sumiu: nada a enviar (e nada a apagar)
            }
            if (impressao.equals(meta.get(META_IGNORAR + candidata.uuid))) {
                continue; // já recusado em definitivo para este mesmo arquivo
            }

            byte[] bytes;
            try {
                bytes = bytesToUpload(candidata.caminho);
            } catch (IOException | RuntimeException e) {
                Log.w(TAG, "foto ilegível; não será reenviada enquanto o arquivo não mudar", e);
                meta.put(META_IGNORAR + candidata.uuid, impressao);
                continue;
            }

            tentativas++;
            try {
                ApiClient.Response resposta = api.putFile(
                        "/v1/workspaces/" + workspaceId + "/images", "image/webp", bytes,
                        session.accessToken());
                String hash = resposta.body.optString("hash", null);
                if (!PhotoRules.isValidHash(hash)) {
                    Log.w(TAG, "resposta do upload sem hash válido");
                    break;
                }
                if (products.markPhotoUploaded(candidata.uuid, candidata.caminho, hash)) {
                    enviadas++;
                }
                meta.remove(META_IGNORAR + candidata.uuid);
            } catch (ApiException e) {
                if (PhotoRules.isPermanentUploadFailure(e.getStatusCode(), e.getCode())) {
                    Log.w(TAG, "imagem recusada pela API: " + e.getCode());
                    meta.put(META_IGNORAR + candidata.uuid, impressao);
                    continue;
                }
                if (e.isPlanLimit()) {
                    meta.put(SyncMeta.FOTOS_AVISO, "O armazenamento de fotos do plano está cheio. "
                            + "As fotos continuam neste aparelho e sobem quando houver espaço.");
                    bloqueada = true;
                } else if (e.getStatusCode() == 403
                        && !"SUBSCRIPTION_REQUIRED".equals(e.getCode())
                        && !e.isPlanBlocked()) {
                    meta.put(SyncMeta.FOTOS_AVISO, "Seu papel na empresa não permite enviar "
                            + "fotos de produtos. Elas continuam neste aparelho.");
                    bloqueada = true;
                }
                Log.i(TAG, "envio de fotos pausado: " + e.getCode() + " (" + e.getStatusCode() + ")");
                // Cota, permissão, rede, 429/5xx, sessão: o resto espera a próxima rodada.
                return enviadas;
            }
        }

        if (!bloqueada && enviadas > 0) {
            meta.remove(SyncMeta.FOTOS_AVISO);
        }
        return enviadas;
    }

    private List<Candidata> candidatas() {
        List<Candidata> lista = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT uuid, photo FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE deleted_at IS NULL AND uuid IS NOT NULL AND photo IS NOT NULL"
                    + " AND photo <> '' AND photo <> 'null' AND photo_hash IS NULL"
                    + " ORDER BY id LIMIT 200", null);
            while (cursor.moveToNext()) {
                lista.add(new Candidata(cursor.getString(0), cursor.getString(1)));
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar fotos pendentes", e);
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        return lista;
    }

    /** Identifica "este arquivo neste estado"; nulo se o arquivo não existe. */
    private String fingerprint(String path) {
        if (PhotoPathHelper.isContentUri(path)) {
            return path;
        }
        File file = new File(path);
        if (!file.isFile()) {
            return null;
        }
        return path + "|" + file.length() + "|" + file.lastModified();
    }

    /**
     * Bytes a enviar. WebP já otimizado segue como está; qualquer outra coisa
     * (fotos antigas em JPEG de vários MB, {@code content://} legado) é
     * otimizada em memória — o arquivo local não é alterado.
     */
    private byte[] bytesToUpload(String path) throws IOException {
        if (PhotoPathHelper.isContentUri(path)) {
            return ImageOptimizer.optimizeUriToBytes(context, Uri.parse(path));
        }
        File file = new File(path);
        if (file.getName().endsWith(".webp") && file.length() <= PhotoRules.MAX_UPLOAD_BYTES
                && isWebp(file)) {
            byte[] bytes = new byte[(int) file.length()];
            try (InputStream in = new FileInputStream(file)) {
                int off = 0;
                while (off < bytes.length) {
                    int n = in.read(bytes, off, bytes.length - off);
                    if (n < 0) {
                        throw new IOException("arquivo truncado");
                    }
                    off += n;
                }
            }
            return bytes;
        }
        return ImageOptimizer.optimizeFileToBytes(file);
    }

    private static boolean isWebp(File file) {
        byte[] header = new byte[12];
        try (InputStream in = new FileInputStream(file)) {
            if (in.read(header) != 12) {
                return false;
            }
        } catch (IOException e) {
            return false;
        }
        return header[0] == 'R' && header[1] == 'I' && header[2] == 'F' && header[3] == 'F'
                && header[8] == 'W' && header[9] == 'E' && header[10] == 'B' && header[11] == 'P';
    }

    // -------------------------------------------------------------------------
    // Download
    // -------------------------------------------------------------------------

    /** @return quantas imagens foram baixadas nesta rodada. */
    public int downloadMissing() {
        String workspaceId = session.workspaceId();
        File folder = PhotoPathHelper.getImagesFolder(context);
        if (workspaceId == null || folder == null) {
            return 0;
        }

        List<String[]> faltando = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT uuid, photo, photo_hash FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE deleted_at IS NULL AND uuid IS NOT NULL AND photo_hash IS NOT NULL",
                    null);
            while (cursor.moveToNext()) {
                String foto = cursor.isNull(1) ? null : cursor.getString(1);
                boolean existe = !PhotoRules.isEmptyPath(foto)
                        && (PhotoPathHelper.isContentUri(foto) || new File(foto).isFile());
                if (PhotoRules.needsDownload(cursor.getString(2), existe)) {
                    faltando.add(new String[]{cursor.getString(0), cursor.getString(2)});
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "falha ao listar fotos a baixar", e);
            return 0;
        } finally {
            LocalDb.closeQuietly(cursor);
        }

        int baixadas = 0;
        int tentativas = 0;
        long agora = System.currentTimeMillis();
        for (String[] item : faltando) {
            if (parar() || tentativas >= MAX_DOWNLOADS_PER_CYCLE) {
                break;
            }
            String uuid = item[0];
            String hash = item[1];
            if (!PhotoRules.isValidHash(hash) || meta.getLong(META_ADIAR + hash, 0L) > agora) {
                continue;
            }
            File alvo = new File(folder, PhotoRules.canonicalName(hash));

            if (!PhotoFiles.fileMatches(alvo, hash)) {
                tentativas++;
                try {
                    ApiClient.Response resposta = api.getFile(
                            "/v1/workspaces/" + workspaceId + "/images/" + hash,
                            session.accessToken(), MAX_DOWNLOAD_BYTES);
                    if (!PhotoRules.matchesHash(resposta.bytes, hash)) {
                        Log.w(TAG, "imagem baixada não confere com o hash; descartada");
                        meta.put(META_ADIAR + hash, agora + NOT_FOUND_RETRY_MS);
                        continue;
                    }
                    PhotoFiles.writeAtomically(alvo, resposta.bytes);
                } catch (ApiException e) {
                    if (e.getStatusCode() == 404) {
                        // Já foi recolhida (ou nunca existiu para esta empresa).
                        meta.put(META_ADIAR + hash, agora + NOT_FOUND_RETRY_MS);
                        continue;
                    }
                    Log.i(TAG, "download de fotos pausado: " + e.getCode());
                    break;
                } catch (IOException e) {
                    Log.w(TAG, "não foi possível gravar a imagem baixada", e);
                    break;
                }
            }

            // Sem mexer em rev nem na fila: é o estado local de algo que veio da nuvem.
            db.execSQL("UPDATE " + LocalDb.TABLE_PRODUCTS + " SET photo=? "
                            + "WHERE uuid=? AND photo_hash=?",
                    new Object[]{alvo.getAbsolutePath(), uuid, hash});
            meta.remove(META_ADIAR + hash);
            baixadas++;
        }
        return baixadas;
    }
}
