package br.com.gameloop.estoquesimples.branding;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.util.Log;

import androidx.annotation.Nullable;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.ApiException;

/**
 * Logotipo da empresa em cache local ({@code files/brand/<hash>.webp}). O
 * nome do arquivo é o hash do conteúdo: trocar o logotipo no servidor troca o
 * arquivo, então não há cache velho para invalidar.
 */
public final class BrandLogo {

    private static final String TAG = "BrandLogo";
    private static final int MAX_BYTES = 512 * 1024;

    private BrandLogo() {
    }

    private static File dir(Context context) {
        return new File(context.getApplicationContext().getFilesDir(), "brand");
    }

    private static File file(Context context, String hash) {
        return new File(dir(context), hash + ".webp");
    }

    /** Baixa o logotipo se ainda não está em cache. Faz rede: nunca na thread principal. */
    public static void ensure(Context context, @Nullable Brand brand) {
        if (brand == null || brand.logoUrl == null || brand.logoHash == null) {
            clear(context);
            return;
        }
        File target = file(context, brand.logoHash);
        if (target.exists()) {
            return;
        }
        try {
            ApiClient.Response response = new ApiClient().getFile(brand.logoUrl, null, MAX_BYTES);
            byte[] bytes = response.bytes;
            if (bytes == null || bytes.length == 0 || !decodes(bytes)) {
                return;
            }
            dir(context).mkdirs();
            File temp = new File(dir(context), brand.logoHash + ".tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write(bytes);
            }
            if (!temp.renameTo(target)) {
                temp.delete();
                return;
            }
            // Logotipos anteriores saem: só o atual fica.
            File[] others = dir(context).listFiles();
            if (others != null) {
                for (File other : others) {
                    if (!other.equals(target)) {
                        other.delete();
                    }
                }
            }
        } catch (ApiException | IOException e) {
            // Sem rede agora: o app segue com as cores e tenta de novo no próximo ciclo.
            Log.w(TAG, "logotipo não baixado: " + e.getMessage());
        }
    }

    private static boolean decodes(byte[] bytes) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        return options.outWidth > 0 && options.outHeight > 0;
    }

    public static void clear(Context context) {
        File[] files = dir(context).listFiles();
        if (files != null) {
            for (File item : files) {
                item.delete();
            }
        }
    }

    /**
     * Logotipo pronto para a barra superior: sobre uma pastilha branca (o
     * logotipo é feito para fundo claro e a barra é da cor da empresa), com a
     * altura pedida e a proporção original.
     */
    @Nullable
    public static Drawable barDrawable(Context context, @Nullable Brand brand, int heightPx) {
        if (brand == null || brand.logoHash == null) {
            return null;
        }
        File source = file(context, brand.logoHash);
        if (!source.exists()) {
            return null;
        }
        Bitmap logo = BitmapFactory.decodeFile(source.getAbsolutePath());
        if (logo == null) {
            return null;
        }
        int pad = Math.round(heightPx * 0.14f);
        int innerHeight = heightPx - 2 * pad;
        int innerWidth = Math.min(Math.round(innerHeight * (logo.getWidth() / (float) logo.getHeight())), heightPx * 4);
        Bitmap chip = Bitmap.createBitmap(innerWidth + 2 * pad, heightPx, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(chip);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        paint.setColor(0xFFFFFFFF);
        canvas.drawRoundRect(new RectF(0, 0, chip.getWidth(), chip.getHeight()), pad * 1.5f, pad * 1.5f, paint);
        canvas.drawBitmap(logo, null, new RectF(pad, pad, pad + innerWidth, pad + innerHeight), paint);
        logo.recycle();
        return new BitmapDrawable(context.getResources(), chip);
    }
}
