package br.com.gameloop.estoquesimples.photos;

import android.content.ContentResolver;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.PhotoPathHelper;

/**
 * Prepara a foto de um produto para ficar no aparelho e subir para a nuvem.
 *
 * Regras (as mesmas que o servidor aplica, para que o arquivo enviado já seja
 * o definitivo): lado maior de no máximo 1280 px, nunca ampliar, orientação do
 * EXIF aplicada e metadados descartados (a imagem é recodificada), WebP, até
 * 250 KB — qualidade 80, depois 70 e 60, e só então reduz as dimensões em
 * passos de 15%.
 *
 * <p>A decodificação usa {@code inSampleSize} e depois escala exato, para nunca
 * carregar uma foto de 12 MP inteira na memória. Tudo aqui é trabalho de
 * disco/CPU: chamar fora da thread principal ({@link #importUriAsync}).
 */
public final class ImageOptimizer {

    private static final String TAG = "ImageOptimizer";

    public static final int MAX_EDGE = 1280;
    public static final int TARGET_BYTES = 250 * 1024;
    public static final int[] QUALITIES = {80, 70, 60};
    public static final double SHRINK_STEP = 0.85;
    /** Abaixo disso não adianta reduzir mais; devolve o melhor que deu. */
    public static final int MIN_EDGE = 320;

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "photo-optimizer");
        t.setDaemon(true);
        return t;
    });

    private ImageOptimizer() {
    }

    /** Quem recebe o resultado, sempre na thread principal. */
    public interface Callback {
        /** @param path caminho do arquivo pronto, ou {@code null} se falhou. */
        void onResult(String path);
    }

    /** Fonte de bytes reabrível: o decodificador lê duas vezes (limites e pixels). */
    interface Source {
        InputStream open() throws IOException;
    }

    // -------------------------------------------------------------------------
    // Geometria (pura)
    // -------------------------------------------------------------------------

    /** Dimensões finais: lado maior limitado a {@code maxEdge}, sem ampliar. */
    public static int[] fit(int width, int height, int maxEdge) {
        int longest = Math.max(width, height);
        if (longest <= maxEdge || longest <= 0) {
            return new int[]{width, height};
        }
        double scale = (double) maxEdge / longest;
        return new int[]{
                Math.max(1, (int) Math.round(width * scale)),
                Math.max(1, (int) Math.round(height * scale))};
    }

    /**
     * Maior potência de 2 que ainda deixa a imagem decodificada com o lado
     * maior {@code >= maxEdge}; a escala final exata é feita depois.
     */
    public static int sampleSize(int width, int height, int maxEdge) {
        int longest = Math.max(width, height);
        int sample = 1;
        while (longest / (sample * 2) >= maxEdge) {
            sample *= 2;
        }
        return sample;
    }

    /** Próximo passo da escada de dimensões (nunca abaixo de 1). */
    public static int[] shrink(int width, int height) {
        return new int[]{
                Math.max(1, (int) Math.round(width * SHRINK_STEP)),
                Math.max(1, (int) Math.round(height * SHRINK_STEP))};
    }

    // -------------------------------------------------------------------------
    // Pontos de entrada
    // -------------------------------------------------------------------------

    /**
     * Otimiza uma imagem escolhida na galeria e grava na pasta de fotos.
     * Se a otimização falhar, cai na cópia simples (comportamento anterior) e
     * a foto será otimizada no momento do envio.
     */
    public static void importUriAsync(Context context, Uri uri, Callback callback) {
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            String result = null;
            try {
                File folder = PhotoPathHelper.getImagesFolder(app);
                if (folder != null) {
                    ContentResolver resolver = app.getContentResolver();
                    File out = optimizeToFolder(() -> {
                        InputStream in = resolver.openInputStream(uri);
                        if (in == null) {
                            throw new IOException("sem fluxo para " + uri);
                        }
                        return in;
                    }, folder);
                    result = out.getAbsolutePath();
                }
            } catch (Throwable e) {
                Log.w(TAG, "falha ao otimizar a imagem escolhida; usando cópia simples", e);
            }
            if (result == null) {
                result = PhotoPathHelper.copyUriToAppFolder(app, uri);
            }
            deliver(callback, result);
        });
    }

    /**
     * Otimiza o arquivo gravado pela câmera (JPEG grande, na pasta de fotos) e
     * apaga o original. Em caso de falha devolve o próprio original.
     */
    public static void importCameraFileAsync(Context context, File original, Callback callback) {
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            String result = original.getAbsolutePath();
            try {
                File folder = PhotoPathHelper.getImagesFolder(app);
                if (folder != null) {
                    File out = optimizeToFolder(() -> new FileInputStream(original), folder);
                    result = out.getAbsolutePath();
                    if (!original.delete()) {
                        Log.w(TAG, "não foi possível apagar o original da câmera");
                    }
                }
            } catch (Throwable e) {
                Log.w(TAG, "falha ao otimizar a foto da câmera; mantendo o original", e);
            }
            deliver(callback, result);
        });
    }

    /** Bytes WebP prontos para envio, a partir de um arquivo local (síncrono). */
    public static byte[] optimizeFileToBytes(File file) throws IOException {
        return optimize(() -> new FileInputStream(file));
    }

    /** Idem, a partir de uma URI (fotos legadas {@code content://}). */
    public static byte[] optimizeUriToBytes(Context context, Uri uri) throws IOException {
        ContentResolver resolver = context.getApplicationContext().getContentResolver();
        return optimize(() -> {
            InputStream in = resolver.openInputStream(uri);
            if (in == null) {
                throw new IOException("sem fluxo para " + uri);
            }
            return in;
        });
    }

    private static void deliver(Callback callback, String path) {
        new Handler(Looper.getMainLooper()).post(() -> callback.onResult(path));
    }

    // -------------------------------------------------------------------------
    // Núcleo
    // -------------------------------------------------------------------------

    private static File optimizeToFolder(Source source, File folder) throws IOException {
        byte[] bytes = optimize(source);
        File out = new File(folder, "es_" + System.currentTimeMillis() + "_"
                + UUID.randomUUID().toString().substring(0, 6) + ".webp");
        try (FileOutputStream stream = new FileOutputStream(out)) {
            stream.write(bytes);
            stream.getFD().sync();
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        }
        return out;
    }

    static byte[] optimize(Source source) throws IOException {
        // Limites primeiro: decodificar sem alocar pixels.
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = source.open()) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("não é uma imagem decodificável");
        }

        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try (InputStream in = source.open()) {
            orientation = new ExifInterface(in).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception e) {
            // Sem EXIF (PNG, WebP) a imagem já está na orientação certa.
            Log.d(TAG, "sem orientação EXIF: " + e.getMessage());
        }

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, MAX_EDGE);
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap decoded;
        try (InputStream in = source.open()) {
            decoded = BitmapFactory.decodeStream(in, null, options);
        }
        if (decoded == null) {
            throw new IOException("falha ao decodificar a imagem");
        }

        Bitmap base = null;
        try {
            int[] size = fit(decoded.getWidth(), decoded.getHeight(), MAX_EDGE);
            Bitmap scaled = decoded;
            if (size[0] != decoded.getWidth() || size[1] != decoded.getHeight()) {
                scaled = Bitmap.createScaledBitmap(decoded, size[0], size[1], true);
            }
            base = rotate(scaled, orientation);
            if (scaled != decoded && scaled != base) {
                scaled.recycle();
            }
            return encodeWithinBudget(base);
        } finally {
            if (base != null && base != decoded) {
                base.recycle();
            }
            decoded.recycle();
        }
    }

    private static byte[] encodeWithinBudget(Bitmap base) throws IOException {
        int width = base.getWidth();
        int height = base.getHeight();
        byte[] best = null;

        while (true) {
            Bitmap candidate = base;
            if (width != base.getWidth() || height != base.getHeight()) {
                candidate = Bitmap.createScaledBitmap(base, width, height, true);
            }
            try {
                for (int quality : QUALITIES) {
                    best = compress(candidate, quality);
                    if (best.length <= TARGET_BYTES) {
                        return best;
                    }
                }
            } finally {
                if (candidate != base) {
                    candidate.recycle();
                }
            }
            if (Math.max(width, height) <= MIN_EDGE) {
                return best;
            }
            int[] next = shrink(width, height);
            width = next[0];
            height = next[1];
        }
    }

    private static byte[] compress(Bitmap bitmap, int quality) throws IOException {
        Bitmap.CompressFormat format = Build.VERSION.SDK_INT >= 30
                ? Bitmap.CompressFormat.WEBP_LOSSY
                : Bitmap.CompressFormat.WEBP;
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        if (!bitmap.compress(format, quality, out)) {
            throw new IOException("falha ao codificar WebP");
        }
        return out.toByteArray();
    }

    private static Bitmap rotate(Bitmap bitmap, int orientation) {
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.postRotate(90);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.postRotate(180);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.postRotate(270);
                break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                matrix.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                matrix.postScale(1, -1);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                matrix.postRotate(90);
                matrix.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                matrix.postRotate(270);
                matrix.postScale(-1, 1);
                break;
            default:
                return bitmap;
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
    }
}
