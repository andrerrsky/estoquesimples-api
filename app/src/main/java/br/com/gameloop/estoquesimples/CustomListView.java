package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Log;
import android.util.SparseBooleanArray;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.appcompat.app.AlertDialog;

import com.squareup.picasso.Picasso;

import java.io.File;
import java.util.ArrayList;

public class CustomListView extends ArrayAdapter<String> {

    private Activity context;

    private ArrayList<String> names;
    private ArrayList<String> amounts;
    private ArrayList<String> values;
    private ArrayList<String> photos;
    private ArrayList<String> categories;
    private ArrayList<String> skus;
    private ArrayList<String> locations;
    private ArrayList<String> minStocks;
    private ArrayList<String> units;

    private static final String TAG = "CustomListView";
    private static final String IMAGE_TYPE = "image/*";
    private final SparseBooleanArray expandedPositions = new SparseBooleanArray();

    public CustomListView(Activity context, ArrayList<String> names, ArrayList<String> amounts, 
                         ArrayList<String> values, ArrayList<String> photos, ArrayList<String> categories,
                         ArrayList<String> skus, ArrayList<String> locations, 
                         ArrayList<String> minStocks, ArrayList<String> units) {

        super(context, R.layout.custom_listview, names);

        this.context = context;
        this.names = names;
        this.amounts = amounts;
        this.values = values;
        this.photos = photos;
        this.categories = categories;
        this.skus = skus;
        this.locations = locations;
        this.minStocks = minStocks;
        this.units = units;

    }

    @Override
    public View getView(int position, View view, ViewGroup parent) {

        LayoutInflater inflater = this.context.getLayoutInflater();
        View rowView = inflater.inflate(R.layout.custom_listview, null, true);

        // Views principais
        TextView name = (TextView) rowView.findViewById(R.id.name);
        TextView amount = (TextView) rowView.findViewById(R.id.amount);
        TextView value = (TextView) rowView.findViewById(R.id.value);
        ImageView photo = (ImageView) rowView.findViewById(R.id.photo);
        LinearLayout extraContainer = (LinearLayout) rowView.findViewById(R.id.extraContainer);
        ImageView toggleIcon = (ImageView) rowView.findViewById(R.id.toggleIcon);
        
        // Novos campos
        TextView category = (TextView) rowView.findViewById(R.id.category);
        TextView sku = (TextView) rowView.findViewById(R.id.sku);
        TextView unit = (TextView) rowView.findViewById(R.id.unit);
        TextView lowStockBadge = (TextView) rowView.findViewById(R.id.lowStockBadge);
        TextView skuDivider = (TextView) rowView.findViewById(R.id.skuDivider);

        final int finalPosition = position;

        ImageButton edit = (ImageButton) rowView.findViewById(R.id.edit);
        edit.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                MainActivity.instance.showEditActivity(names.get(finalPosition));
            }
        });

        // Toggle expand/collapse when clicking on toggle icon
        View.OnClickListener toggleListener = new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                boolean expanded = expandedPositions.get(finalPosition, false);
                expandedPositions.put(finalPosition, !expanded);
                notifyDataSetChanged();
            }
        };
        toggleIcon.setOnClickListener(toggleListener);

        ImageButton delete = (ImageButton) rowView.findViewById(R.id.delete);
        delete.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                MainActivity.instance.deleteProduct(names.get(finalPosition));
            }
        });

        photo.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String photoPath = photos.get(finalPosition);
                if(photoPath != null && !photoPath.isEmpty() && !photoPath.equals("null")) {
                    try {
                        File photoFile = new File(photoPath);
                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        
                        // Verificar se o arquivo existe
                        if (photoFile.exists()) {
                            // Usar FileProvider para criar URI segura
                            Uri photoUri = FileProvider.getUriForFile(
                                context,
                                context.getApplicationContext().getPackageName() + ".fileprovider",
                                photoFile
                            );
                            intent.setDataAndType(photoUri, IMAGE_TYPE);
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        } else {
                            // Se o arquivo não existir, tentar usar a URI diretamente (para URIs de content://)
                            Uri photoUri = Uri.parse(photoPath);
                            intent.setDataAndType(photoUri, IMAGE_TYPE);
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        }
                        
                        context.startActivity(intent);
                    } catch (Exception e) {
                        Log.e(TAG, "Erro ao abrir foto", e);
                        Toast.makeText(context, "Erro ao abrir foto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                    }
                }
            }
        });

        // Definir valores básicos
        name.setText(names.get(position));
        
        // Quantidade com estoque mínimo (formato: "atual / minimo")
        String amountText = amounts.get(position);
        String minStockStr = minStocks.get(position);
        boolean hasMinStock = minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null") && !minStockStr.equals("0");
        
        if(hasMinStock) {
            amountText = amounts.get(position) + " / " + minStockStr;
        }
        amount.setText(amountText);
        
        // Valor
        value.setText("$ " + values.get(position));

        // Foto - com limite de tamanho para evitar crashes por bitmaps muito grandes
        if(photos.get(position) != null && !photos.get(position).isEmpty() && !photos.get(position).equals("null")) {
            try {
                Picasso.get()
                    .load("file://" + photos.get(position))
                    .resize(800, 800) // Limita dimensões máximas a 800x800px
                    .centerInside() // Mantém aspect ratio
                    .onlyScaleDown() // Não aumenta imagens menores
                    .placeholder(R.drawable.package_icon) // Placeholder durante carregamento
                    .error(R.drawable.package_icon) // Imagem de erro caso falhe
                    .into(photo);
            } catch (Exception e) {
                Log.e(TAG, "Erro ao carregar foto na posição " + position, e);
                photo.setImageResource(R.drawable.package_icon);
            }
        } else {
            photo.setImageResource(R.drawable.package_icon);
        }

        // SKU
        if(skus.get(position) != null && !skus.get(position).isEmpty() && !skus.get(position).equals("null")) {
            sku.setText(skus.get(position));
            sku.setVisibility(View.VISIBLE);
        } else {
            sku.setVisibility(View.GONE);
        }

        // Categoria
        if(categories.get(position) != null && !categories.get(position).isEmpty() && !categories.get(position).equals("null")) {
            category.setText(categories.get(position));
            category.setVisibility(View.VISIBLE);
            
            // Mostrar divider apenas se SKU também estiver visível
            if(sku.getVisibility() == View.VISIBLE) {
                skuDivider.setVisibility(View.VISIBLE);
            }
        } else {
            category.setVisibility(View.GONE);
            skuDivider.setVisibility(View.GONE);
        }

        // Unidade - ocultar quando houver barra de estoque mínimo
        if(!hasMinStock && units.get(position) != null && !units.get(position).isEmpty() && !units.get(position).equals("null")) {
            unit.setText(" " + units.get(position));
            unit.setVisibility(View.VISIBLE);
        } else {
            unit.setVisibility(View.GONE);
        }

        // Alerta de estoque baixo
        try {
            double currentAmount = Double.parseDouble(amounts.get(position));
            minStockStr = minStocks.get(position);
            
            if(minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null")) {
                double minStockValue = Double.parseDouble(minStockStr);
                
                if(minStockValue > 0 && currentAmount <= minStockValue) {
                    lowStockBadge.setVisibility(View.VISIBLE);
                    amount.setTextColor(0xFFFF5722); // Laranja/vermelho para alerta
                } else {
                    lowStockBadge.setVisibility(View.GONE);
                    amount.setTextColor(0xFF666666); // Cinza normal
                }
            } else {
                lowStockBadge.setVisibility(View.GONE);
                amount.setTextColor(0xFF666666);
            }
        } catch (NumberFormatException e) {
            lowStockBadge.setVisibility(View.GONE);
            amount.setTextColor(0xFF666666);
        }

        // Estado expandido/colapsado
        boolean isExpanded = expandedPositions.get(position, false);
        extraContainer.setVisibility(isExpanded ? View.VISIBLE : View.GONE);
        toggleIcon.setImageResource(isExpanded ? R.drawable.ic_expand_less : R.drawable.ic_expand_more);

        // Campos de detalhes (apenas preenche, a visibilidade da seção é controlada acima)
        TextView detailMinStock = (TextView) rowView.findViewById(R.id.detailMinStock);
        TextView detailUnit = (TextView) rowView.findViewById(R.id.detailUnit);
        TextView detailLocation = (TextView) rowView.findViewById(R.id.detailLocation);
        TextView detailSku = (TextView) rowView.findViewById(R.id.detailSku);
        TextView detailCategory = (TextView) rowView.findViewById(R.id.detailCategory);

        minStockStr = minStocks.get(position);
        if(minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null")) {
            detailMinStock.setText(minStockStr);
        } else {
            detailMinStock.setText("-");
        }

        String unitStr = units.get(position);
        if(unitStr != null && !unitStr.isEmpty() && !unitStr.equals("null")) {
            detailUnit.setText(unitStr);
        } else {
            detailUnit.setText("-");
        }

        String locationStr = locations.get(position);
        if(locationStr != null && !locationStr.isEmpty() && !locationStr.equals("null")) {
            detailLocation.setText(locationStr);
        } else {
            detailLocation.setText("-");
        }

        String skuStr = skus.get(position);
        if(skuStr != null && !skuStr.isEmpty() && !skuStr.equals("null")) {
            detailSku.setText(skuStr);
        } else {
            detailSku.setText("-");
        }

        String categoryStr = categories.get(position);
        if(categoryStr != null && !categoryStr.isEmpty() && !categoryStr.equals("null")) {
            detailCategory.setText(categoryStr);
        } else {
            detailCategory.setText("-");
        }

        // Ações de estoque (Entrada / Saída)
        Button btnEntrada = (Button) rowView.findViewById(R.id.btnEntrada);
        Button btnSaida = (Button) rowView.findViewById(R.id.btnSaida);

        if (btnEntrada != null) {
            btnEntrada.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showStockDialog(finalPosition, true);
                }
            });
        }

        if (btnSaida != null) {
            btnSaida.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showStockDialog(finalPosition, false);
                }
            });
        }

        return rowView;

    }

    private void showStockDialog(int position, boolean isEntrada) {
        String productName = names.get(position);

        AlertDialog.Builder builder = new AlertDialog.Builder(context);
        builder.setTitle(isEntrada ? "Entrada de estoque" : "Saída de estoque");
        builder.setMessage(productName);

        LinearLayout container = new LinearLayout(context);
        container.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (context.getResources().getDisplayMetrics().density * 16);
        container.setPadding(padding, padding, padding, padding);

        final EditText inputQty = new EditText(context);
        inputQty.setHint("Quantidade");
        inputQty.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL | android.text.InputType.TYPE_NUMBER_FLAG_SIGNED);
        container.addView(inputQty);

        final EditText inputNote = new EditText(context);
        inputNote.setHint("Observação (opcional)");
        inputNote.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = (int) (context.getResources().getDisplayMetrics().density * 8);
        inputNote.setLayoutParams(params);
        container.addView(inputNote);

        builder.setView(container);

        builder.setPositiveButton("Confirmar", (dialog, which) -> {
            String qtyStr = inputQty.getText().toString().trim();
            if (qtyStr.isEmpty()) {
                Toast.makeText(context, "Informe a quantidade", Toast.LENGTH_SHORT).show();
                return;
            }
            double qty;
            try {
                qty = Double.parseDouble(qtyStr);
            } catch (NumberFormatException e) {
                Toast.makeText(context, "Quantidade inválida", Toast.LENGTH_SHORT).show();
                return;
            }
            if (qty <= 0) {
                Toast.makeText(context, "Quantidade deve ser maior que zero", Toast.LENGTH_SHORT).show();
                return;
            }

            double currentAmount = 0;
            try {
                currentAmount = Double.parseDouble(amounts.get(position));
            } catch (NumberFormatException ignored) { }

            double newAmount = isEntrada ? (currentAmount + qty) : (currentAmount - qty);
            if (!isEntrada && newAmount < 0) {
                Toast.makeText(context, "Quantidade insuficiente em estoque", Toast.LENGTH_SHORT).show();
                return;
            }

            // Atualizar estoque
            android.content.ContentValues values = new android.content.ContentValues();
            values.put("amount", String.valueOf(newAmount));
            MainActivity.stock.update("Estoque", values, "name='" + productName + "'", null);

            // Inserir histórico
            android.content.ContentValues hist = new android.content.ContentValues();
            hist.put("product_name", productName);
            hist.put("change_type", isEntrada ? "entrada" : "saida");
            hist.put("quantity", qty);
            hist.put("timestamp", System.currentTimeMillis());
            String note = inputNote.getText().toString().trim();
            if (!note.isEmpty()) {
                hist.put("note", note);
            }
            MainActivity.stock.insert("EstoqueHistorico", null, hist);

            // Atualizar lista
            MainActivity.instance.updateList();
            Toast.makeText(context, isEntrada ? "Entrada registrada" : "Saída registrada", Toast.LENGTH_SHORT).show();
        });

        builder.setNegativeButton("Cancelar", (dialog, which) -> dialog.dismiss());
        builder.show();
    }

}