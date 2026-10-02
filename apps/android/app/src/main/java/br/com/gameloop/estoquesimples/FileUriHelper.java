package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.core.content.FileProvider;

import java.io.File;

/**
 * Classe utilitária para criar URIs de forma segura, prevenindo FileUriExposedException.
 * 
 * Esta classe garante que:
 * - Android 7.0+ (API 24) sempre usa FileProvider
 * - Android 6.0 e inferior pode usar file:// diretamente
 * - Todos os erros são tratados graciosamente
 */
public class FileUriHelper {
    
    private static final String TAG = "FileUriHelper";
    
    /**
     * Cria uma URI segura para um arquivo, usando FileProvider quando necessário.
     * 
     * @param context Contexto da aplicação
     * @param file Arquivo para criar URI
     * @return URI segura para o arquivo, ou null se houver erro
     */
    public static Uri getUriForFile(Context context, File file) {
        if (context == null) {
            Log.e(TAG, "Context is null, cannot create URI");
            return null;
        }
        
        if (file == null || !file.exists()) {
            Log.e(TAG, "File is null or does not exist: " + (file != null ? file.getAbsolutePath() : "null"));
            return null;
        }
        
        try {
            // Android 7.0+ (API 24) requer FileProvider para evitar FileUriExposedException
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                String authority = context.getApplicationContext().getPackageName() + ".fileprovider";
                Uri uri = FileProvider.getUriForFile(context, authority, file);
                Log.d(TAG, "Created FileProvider URI: " + uri);
                return uri;
            } else {
                // Android 6.0 e inferior pode usar file:// diretamente
                Uri uri = Uri.fromFile(file);
                Log.d(TAG, "Created file:// URI: " + uri);
                return uri;
            }
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "FileProvider configuration error. Check file_paths.xml and AndroidManifest.xml", e);
            Log.e(TAG, "Failed file path: " + file.getAbsolutePath());
            return null;
        } catch (Exception e) {
            Log.e(TAG, "Error creating URI for file: " + file.getAbsolutePath(), e);
            return null;
        }
    }
    
    /**
     * Verifica se uma URI é segura para ser usada em um Intent.
     * 
     * @param uri URI para verificar
     * @return true se a URI é segura, false caso contrário
     */
    public static boolean isUriSafe(Uri uri) {
        if (uri == null) {
            return false;
        }
        
        // A partir do Android 7.0, apenas content:// URIs são seguras para Intents
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            return uri.getScheme() != null && uri.getScheme().equals("content");
        }
        
        // Em versões antigas, tanto file:// quanto content:// são aceitáveis
        return true;
    }
}

