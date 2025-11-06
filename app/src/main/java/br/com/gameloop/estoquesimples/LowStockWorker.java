package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.ArrayList;
import java.util.List;

/**
 * Worker que verifica periodicamente produtos com estoque baixo
 * e envia notificações a cada 4 horas
 */
public class LowStockWorker extends Worker {

    public LowStockWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            // Verificar produtos com estoque baixo
            List<String> lowStockProducts = checkLowStockProducts();

            if (!lowStockProducts.isEmpty()) {
                // Enviar notificação
                NotificationHelper notificationHelper = new NotificationHelper(getApplicationContext());
                
                // Criar mensagem com os produtos
                StringBuilder productNames = new StringBuilder();
                int maxProducts = Math.min(3, lowStockProducts.size()); // Mostrar no máximo 3 produtos na notificação
                
                for (int i = 0; i < maxProducts; i++) {
                    productNames.append("• ").append(lowStockProducts.get(i));
                    if (i < maxProducts - 1) {
                        productNames.append("\n");
                    }
                }
                
                if (lowStockProducts.size() > 3) {
                    productNames.append("\n... e mais ").append(lowStockProducts.size() - 3).append(" produto(s)");
                }
                
                notificationHelper.showLowStockNotification(productNames.toString(), lowStockProducts.size());
            }

            return Result.success();
        } catch (Exception e) {
            android.util.Log.e("LowStockWorker", "Erro ao verificar estoque baixo", e);
            return Result.retry();
        }
    }

    /**
     * Verifica produtos com estoque baixo
     * @return Lista de produtos com estoque abaixo do mínimo
     */
    private List<String> checkLowStockProducts() {
        List<String> lowStockProducts = new ArrayList<>();
        SQLiteDatabase db = null;
        Cursor cursor = null;

        try {
            // Abrir banco de dados
            db = getApplicationContext().openOrCreateDatabase("estoque", Context.MODE_PRIVATE, null);

            // Buscar produtos com estoque baixo
            cursor = db.rawQuery(
                "SELECT name, amount, min_stock FROM Estoque WHERE min_stock > 0",
                null
            );

            if (cursor.moveToFirst()) {
                do {
                    String name = cursor.getString(0);
                    double amount = parseWithDefault(cursor.getString(1), 0);
                    double minStock = parseWithDefault(cursor.getString(2), 0);

                    if (amount <= minStock) {
                        lowStockProducts.add(name + " (" + amount + "/" + minStock + ")");
                    }
                } while (cursor.moveToNext());
            }
        } catch (Exception e) {
            android.util.Log.e("LowStockWorker", "Erro ao acessar banco de dados", e);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
            if (db != null && db.isOpen()) {
                db.close();
            }
        }

        return lowStockProducts;
    }

    /**
     * Converte string para double com valor padrão
     */
    private double parseWithDefault(String number, double defaultVal) {
        try {
            if(number == null || number.isEmpty() || number.equals("null")) {
                return defaultVal;
            }
            return Double.parseDouble(number);
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }
}

