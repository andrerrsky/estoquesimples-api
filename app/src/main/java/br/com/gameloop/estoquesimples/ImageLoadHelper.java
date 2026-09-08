package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Log;
import android.widget.ImageView;

import com.squareup.picasso.Picasso;

import java.io.File;

/**
 * Helper class para carregar imagens de forma segura e otimizada.
 * 
 * Esta classe centraliza o carregamento de imagens usando Picasso,
 * garantindo que todas as imagens sejam redimensionadas adequadamente
 * para evitar crashes por bitmaps muito grandes.
 */
public class ImageLoadHelper {
    
    private static final String TAG = "ImageLoadHelper";
    
    // Limites de tamanho para diferentes contextos
    public static final int THUMBNAIL_SIZE = 800;  // Para listas e thumbnails
    public static final int DETAIL_SIZE = 1200;    // Para visualização detalhada
    public static final int MAX_SIZE = 2048;       // Tamanho máximo absoluto
    
    /**
     * Carrega imagem de forma segura para uso em lista/thumbnail.
     * Usa redimensionamento agressivo para economizar memória.
     * 
     * @param context Contexto da aplicação
     * @param imagePath Caminho do arquivo da imagem
     * @param imageView ImageView onde a imagem será exibida
     */
    public static void loadThumbnail(Context context, String imagePath, ImageView imageView) {
        if (PhotoPathHelper.isEmptyPhotoReference(imagePath)) {
            imageView.setImageResource(R.drawable.ic_package);
            return;
        }

        if (PhotoPathHelper.isContentUri(imagePath)) {
            loadDetailImageFromUri(context, Uri.parse(imagePath), imageView, THUMBNAIL_SIZE);
            return;
        }

        try {
            File file = new File(imagePath);
            if (file.exists()) {
                Picasso.get()
                    .load(file)
                    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
                    .centerInside()
                    .onlyScaleDown()
                    .placeholder(R.drawable.ic_package)
                    .error(R.drawable.ic_package)
                    .into(imageView);
            } else {
                imageView.setImageResource(R.drawable.ic_package);
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao carregar thumbnail: " + imagePath, e);
            imageView.setImageResource(R.drawable.ic_package);
        }
    }
    
    /**
     * Carrega imagem de forma segura para visualização detalhada.
     * Usa limite maior mas ainda controlado.
     * 
     * @param context Contexto da aplicação
     * @param imagePath Caminho do arquivo da imagem
     * @param imageView ImageView onde a imagem será exibida
     */
    public static void loadDetailImage(Context context, String imagePath, ImageView imageView) {
        if (PhotoPathHelper.isEmptyPhotoReference(imagePath)) {
            imageView.setImageResource(R.drawable.ic_package);
            return;
        }

        if (PhotoPathHelper.isContentUri(imagePath)) {
            loadDetailImageFromUri(context, Uri.parse(imagePath), imageView, DETAIL_SIZE);
            return;
        }

        try {
            File file = new File(imagePath);
            if (file.exists()) {
                Picasso.get()
                    .load(file)
                    .resize(DETAIL_SIZE, DETAIL_SIZE)
                    .centerInside()
                    .onlyScaleDown()
                    .placeholder(R.drawable.ic_package)
                    .error(R.drawable.ic_package)
                    .into(imageView);
            } else {
                imageView.setImageResource(R.drawable.ic_package);
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao carregar imagem detalhada: " + imagePath, e);
            imageView.setImageResource(R.drawable.ic_package);
        }
    }
    
    /**
     * Carrega imagem de forma segura a partir de URI.
     * Útil para imagens vindas da galeria ou câmera.
     * 
     * @param context Contexto da aplicação
     * @param uri URI da imagem
     * @param imageView ImageView onde a imagem será exibida
     */
    public static void loadDetailImageFromUri(Context context, Uri uri, ImageView imageView) {
        loadDetailImageFromUri(context, uri, imageView, DETAIL_SIZE);
    }

    private static void loadDetailImageFromUri(Context context, Uri uri, ImageView imageView, int maxSize) {
        if (uri == null) {
            imageView.setImageResource(R.drawable.ic_package);
            return;
        }

        try {
            Picasso.get()
                .load(uri)
                .resize(maxSize, maxSize)
                .centerInside()
                .onlyScaleDown()
                .placeholder(R.drawable.ic_package)
                .error(R.drawable.ic_package)
                .into(imageView);
        } catch (Exception e) {
            Log.e(TAG, "Erro ao carregar imagem da URI: " + uri, e);
            imageView.setImageResource(R.drawable.ic_package);
        }
    }
    
    /**
     * Configura o Picasso com otimizações globais.
     * Deve ser chamado no Application.onCreate() ou MainActivity.onCreate().
     * 
     * @param context Contexto da aplicação
     */
    public static void configurePicasso(Context context) {
        try {
            // Configurar Picasso com cache otimizado e formato de bitmap econômico
            Picasso.Builder builder = new Picasso.Builder(context);
            
            // Configura formato RGB_565 para economizar 50% de memória
            // (RGB_565 usa 2 bytes por pixel vs ARGB_8888 que usa 4 bytes)
            builder.defaultBitmapConfig(Bitmap.Config.RGB_565);
            
            // Define o Picasso configurado como singleton
            Picasso picasso = builder.build();
            
            // Habilita indicadores de debug apenas em modo debug
            if (BuildConfig.DEBUG) {
                picasso.setIndicatorsEnabled(false);
                picasso.setLoggingEnabled(true);
            }
            
            Picasso.setSingletonInstance(picasso);
            
            Log.i(TAG, "Picasso configurado com otimizações de memória");
        } catch (Exception e) {
            Log.e(TAG, "Erro ao configurar Picasso", e);
        }
    }
    
    /**
     * Calcula o tamanho estimado de memória que uma imagem ocuparia.
     * Útil para debug e monitoramento.
     * 
     * @param width Largura da imagem
     * @param height Altura da imagem
     * @param config Configuração do bitmap
     * @return Tamanho estimado em bytes
     */
    public static long estimateMemorySize(int width, int height, Bitmap.Config config) {
        int bytesPerPixel = 4; // ARGB_8888
        
        if (config == Bitmap.Config.RGB_565) {
            bytesPerPixel = 2;
        } else if (config == Bitmap.Config.ALPHA_8) {
            bytesPerPixel = 1;
        }
        
        return (long) width * height * bytesPerPixel;
    }
    
    /**
     * Formata tamanho de memória em formato legível.
     * 
     * @param bytes Tamanho em bytes
     * @return String formatada (ex: "2.5 MB")
     */
    public static String formatMemorySize(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        } else if (bytes < 1024 * 1024) {
            return String.format("%.1f KB", bytes / 1024.0);
        } else {
            return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        }
    }
}

