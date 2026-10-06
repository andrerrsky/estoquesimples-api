package br.com.gameloop.estoquesimples.photos;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

import br.com.gameloop.estoquesimples.data.LocalDb;

/** Arquivos das fotos na pasta do app: verificação, gravação atômica e limpeza. */
public final class PhotoFiles {

    private static final String TAG = "PhotoFiles";

    private PhotoFiles() {
    }

    /** O arquivo existe e o SHA-256 dele é {@code hash}. */
    public static boolean fileMatches(File file, String hash) {
        if (file == null || !file.isFile()) {
            return false;
        }
        try (InputStream in = new FileInputStream(file)) {
            return hash.equals(PhotoRules.sha256Hex(in));
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Grava em arquivo temporário na mesma pasta e renomeia: quem lê nunca vê um
     * arquivo pela metade, e uma queda no meio deixa só o temporário.
     */
    public static void writeAtomically(File destination, byte[] bytes) throws IOException {
        File temp = new File(destination.getParentFile(), destination.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
            out.getFD().sync();
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw e;
        }
        if (!temp.renameTo(destination)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw new IOException("não foi possível renomear " + temp.getName());
        }
    }

    /** O caminho está dentro da pasta de fotos do app (nunca apagamos fora dela). */
    public static boolean isInside(File folder, String path) {
        if (folder == null || PhotoRules.isEmptyPath(path) || path.startsWith("content://")) {
            return false;
        }
        try {
            String root = folder.getCanonicalPath() + File.separator;
            return new File(path).getCanonicalPath().startsWith(root);
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Apaga o arquivo se nenhum produto o referencia e ele está na pasta do
     * app. Referência legada ({@code content://}) e arquivos de fora ficam.
     */
    public static void deleteIfUnreferenced(SQLiteDatabase db, File folder, String path) {
        if (!isInside(folder, path)) {
            return;
        }
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT 1 FROM " + LocalDb.TABLE_PRODUCTS
                    + " WHERE photo=? LIMIT 1", new String[]{path});
            if (cursor.moveToFirst()) {
                return;
            }
        } catch (Exception e) {
            Log.w(TAG, "não foi possível conferir referências; arquivo mantido", e);
            return;
        } finally {
            LocalDb.closeQuietly(cursor);
        }
        File file = new File(path);
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "não foi possível apagar " + file.getName());
        }
    }
}
