package br.com.gameloop.estoquesimples;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Centraliza o diretório de fotos, migração de caminhos legados e cópia segura
 * de imagens para o armazenamento privado do app (compatível com scoped storage).
 */
public final class PhotoPathHelper {

    private static final String TAG = "PhotoPathHelper";
    private static final String FOLDER_NAME = "EstoqueSimples";

    private PhotoPathHelper() {}

    /**
     * Retorna a pasta de imagens do app, criando-a se necessário.
     * Preferência: external files/Pictures; fallback: internal files.
     */
    public static File getImagesFolder(Context context) {
        Context appContext = context.getApplicationContext();
        try {
            File externalPictures = appContext.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            if (externalPictures != null) {
                File folder = new File(externalPictures, FOLDER_NAME);
                if (!folder.exists() && !folder.mkdirs()) {
                    Log.w(TAG, "Failed to create external images folder");
                }
                if (folder.exists()) {
                    return folder;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error resolving external images folder", e);
        }

        try {
            File folder = new File(appContext.getFilesDir(), FOLDER_NAME);
            if (!folder.exists() && !folder.mkdirs()) {
                Log.w(TAG, "Failed to create internal images folder");
            }
            return folder.exists() ? folder : null;
        } catch (Exception e) {
            Log.e(TAG, "Error resolving internal images folder", e);
            return null;
        }
    }

    public static boolean isEmptyPhotoReference(String storedPath) {
        return storedPath == null || storedPath.isEmpty() || "null".equals(storedPath);
    }

    public static boolean isContentUri(String storedPath) {
        return storedPath != null && storedPath.startsWith("content://");
    }

    /**
     * Indica se o caminho salvo precisa ser copiado para a pasta privada do app.
     */
    public static boolean needsMigration(Context context, String storedPath) {
        if (isEmptyPhotoReference(storedPath)) {
            return false;
        }
        if (isContentUri(storedPath)) {
            return true;
        }
        if (isInAppFolder(context, storedPath)) {
            return false;
        }
        File file = new File(storedPath);
        return file.exists() && file.canRead();
    }

    public static boolean isInAppFolder(Context context, String storedPath) {
        if (isEmptyPhotoReference(storedPath) || isContentUri(storedPath)) {
            return false;
        }
        try {
            String normalized = new File(storedPath).getCanonicalPath();
            File appFolder = getImagesFolder(context);
            if (appFolder == null) {
                return false;
            }
            String appCanonical = appFolder.getCanonicalPath();
            return normalized.startsWith(appCanonical + File.separator)
                    || normalized.equals(appCanonical);
        } catch (Exception e) {
            Log.w(TAG, "Could not verify app folder for path: " + storedPath, e);
            return false;
        }
    }

    /**
     * Migra uma referência de foto para a pasta do app, se necessário.
     * Retorna o caminho utilizável (novo ou existente), ou o original se não for possível migrar.
     */
    public static String migrateStoredPath(Context context, String storedPath) {
        if (isEmptyPhotoReference(storedPath)) {
            return storedPath;
        }
        if (isInAppFolder(context, storedPath)) {
            return storedPath;
        }
        if (isContentUri(storedPath)) {
            String copied = copyUriToAppFolder(context, Uri.parse(storedPath));
            return copied != null ? copied : storedPath;
        }
        File legacyFile = new File(storedPath);
        if (legacyFile.exists() && legacyFile.canRead()) {
            String copied = copyFileToAppFolder(context, legacyFile);
            return copied != null ? copied : storedPath;
        }
        return storedPath;
    }

    /**
     * Migra fotos legadas no banco de dados para a pasta privada do app.
     *
     * @return quantidade de registros atualizados
     */
    public static int migrateAllPhotosInDatabase(Context context, SQLiteDatabase db) {
        if (db == null || !db.isOpen()) {
            return 0;
        }

        int updated = 0;
        Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT id, photo FROM Estoque WHERE photo IS NOT NULL AND photo != '' AND photo != 'null'", null);
            if (cursor == null) {
                return 0;
            }
            while (cursor.moveToNext()) {
                long id = cursor.getLong(0);
                String photo = cursor.getString(1);
                if (!needsMigration(context, photo)) {
                    continue;
                }
                String migrated = migrateStoredPath(context, photo);
                if (migrated == null || migrated.equals(photo)) {
                    continue;
                }
                if (!isInAppFolder(context, migrated)) {
                    continue;
                }
                ContentValues values = new ContentValues();
                values.put("photo", migrated);
                int rows = db.update("Estoque", values, "id=?", new String[]{String.valueOf(id)});
                if (rows > 0) {
                    updated++;
                    Log.i(TAG, "Migrated photo for product id " + id);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error migrating product photos", e);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return updated;
    }

    public static String copyUriToAppFolder(Context context, Uri sourceUri) {
        if (sourceUri == null) {
            return null;
        }
        File destFolder = getImagesFolder(context);
        if (destFolder == null) {
            return null;
        }
        File destFile = newFileInFolder(destFolder);
        try (InputStream in = context.getContentResolver().openInputStream(sourceUri);
             OutputStream out = new FileOutputStream(destFile)) {
            if (in == null) {
                return null;
            }
            copyStream(in, out);
            return destFile.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "Error copying URI to app folder: " + sourceUri, e);
            if (destFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                destFile.delete();
            }
            return null;
        }
    }

    public static String copyFileToAppFolder(Context context, File sourceFile) {
        if (sourceFile == null || !sourceFile.exists() || !sourceFile.canRead()) {
            return null;
        }
        File destFolder = getImagesFolder(context);
        if (destFolder == null) {
            return null;
        }
        File destFile = newFileInFolder(destFolder);
        try (InputStream in = new java.io.FileInputStream(sourceFile);
             OutputStream out = new FileOutputStream(destFile)) {
            copyStream(in, out);
            return destFile.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "Error copying file to app folder: " + sourceFile.getAbsolutePath(), e);
            if (destFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                destFile.delete();
            }
            return null;
        }
    }

    private static File newFileInFolder(File folder) {
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
        return new File(folder, "es_" + timeStamp + ".jpg");
    }

    private static void copyStream(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
        out.flush();
    }
}
