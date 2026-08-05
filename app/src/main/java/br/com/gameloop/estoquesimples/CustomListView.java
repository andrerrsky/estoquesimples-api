package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.ProductRepository;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
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
import android.widget.RelativeLayout;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.appcompat.app.AlertDialog;

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
    private final boolean showProductImages;

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
        this.showProductImages = SettingsActivity.isShowProductImages(context);

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
                if (PhotoPathHelper.isEmptyPhotoReference(photoPath)) {
                    return;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                    if (PhotoPathHelper.isContentUri(photoPath)) {
                        intent.setDataAndType(Uri.parse(photoPath), IMAGE_TYPE);
                    } else {
                        File photoFile = new File(photoPath);
                        if (photoFile.exists()) {
                            Uri photoUri = FileProvider.getUriForFile(
                                context,
                                context.getApplicationContext().getPackageName() + ".fileprovider",
                                photoFile
                            );
                            intent.setDataAndType(photoUri, IMAGE_TYPE);
                        } else {
                            Toast.makeText(context, "Arquivo de foto não encontrado", Toast.LENGTH_SHORT).show();
                            return;
                        }
                    }

                    context.startActivity(intent);
                } catch (Exception e) {
                    Log.e(TAG, "Erro ao abrir foto", e);
                    Toast.makeText(context, "Erro ao abrir foto: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            }
        });

        // Definir valores básicos
        name.setText(names.get(position));
        
        // Quantidade com estoque mínimo (formato: "atual / minimo")
        // Formata para evitar ".0" em números inteiros (ex.: "18" em vez de "18.0")
        String amountText = CurrencyHelper.formatQuantity(amounts.get(position));
        String minStockStr = minStocks.get(position);
        boolean hasMinStock = minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null") && !minStockStr.equals("0");
        
        if(hasMinStock) {
            amountText = amountText + " / " + CurrencyHelper.formatQuantity(minStockStr);
        }
        amount.setText(amountText);
        
        // Valor
        double parsedValue = CurrencyHelper.parseCurrency(values.get(position), 0.0);
        value.setText(CurrencyHelper.formatCurrency(context, parsedValue));

        // Configuração de exibição de imagens dos produtos
        RelativeLayout photoContainer = (RelativeLayout) rowView.findViewById(R.id.photoContainer);
        LinearLayout nameContainer = (LinearLayout) rowView.findViewById(R.id.listlinearlayout);
        if (!showProductImages) {
            // Ocultar a foto e colapsar o espaço para manter o alinhamento
            if (photoContainer != null) {
                photoContainer.setVisibility(View.GONE);
            }
            if (nameContainer != null && nameContainer.getLayoutParams() instanceof LinearLayout.LayoutParams) {
                LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) nameContainer.getLayoutParams();
                lp.leftMargin = 0;
                nameContainer.setLayoutParams(lp);
            }
        } else {
            if (photoContainer != null) {
                photoContainer.setVisibility(View.VISIBLE);
            }
            String photoPath = photos.get(position);
            ImageLoadHelper.loadThumbnail(context, photoPath, photo);
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
            double currentAmount = CurrencyHelper.parseCurrency(amounts.get(position), 0);
            minStockStr = minStocks.get(position);
            
            if(minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null")) {
                double minStockValue = CurrencyHelper.parseCurrency(minStockStr, 0);
                
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
            detailMinStock.setText(CurrencyHelper.formatQuantity(minStockStr));
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
        if (isEntrada) {
            inputNote.setHint("Observação (opcional)");
            inputNote.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                    | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        } else {
            // Saída para o cliente: campo de informações adicionais mais completo
            inputNote.setHint("Observações / Informações adicionais\n(comprador, endereço, detalhes de entrega ou retirada...)");
            inputNote.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                    | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
                    | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            inputNote.setMinLines(3);
            inputNote.setMaxLines(6);
            inputNote.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        }
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
            double qty = CurrencyHelper.parseCurrency(qtyStr, -1);
            if (qty <= 0) {
                Toast.makeText(context, "Quantidade deve ser maior que zero", Toast.LENGTH_SHORT).show();
                return;
            }

            // Garantir que o banco está disponível antes de gravar
            if (MainActivity.stock == null || !MainActivity.stock.isOpen()) {
                Toast.makeText(context, "Erro: banco de dados não disponível.", Toast.LENGTH_SHORT).show();
                Log.e(TAG, "Database not available in showStockDialog");
                return;
            }

            // O produto é endereçado pelo identificador estável. Pelo nome,
            // dois produtos homônimos seriam movimentados juntos.
            ProductRepository products = new ProductRepository(MainActivity.stock);
            String productUuid = products.findUuidByName(productName);
            if (productUuid == null) {
                Toast.makeText(context, "Produto não encontrado.", Toast.LENGTH_SHORT).show();
                return;
            }

            // A quantidade atual não é mais lida da lista da tela: o
            // repositório lê do banco dentro da transação. Com o valor da tela,
            // duas saídas seguidas partiam do mesmo saldo e uma anulava a outra.
            MovementRepository movements = new MovementRepository(MainActivity.stock);
            String note = inputNote.getText().toString().trim();

            MovementRepository.Result result;
            synchronized (MainActivity.DB_LOCK) {
                result = movements.apply(
                        productUuid,
                        isEntrada ? MovementRepository.ENTRADA : MovementRepository.SAIDA,
                        isEntrada ? qty : -qty,
                        note);
            }

            if (!result.success) {
                Toast.makeText(context, result.message, Toast.LENGTH_SHORT).show();
                return;
            }

            // Atualizar lista
            if (MainActivity.instance != null) {
                MainActivity.instance.updateList();
            }
            Toast.makeText(context, isEntrada ? "Entrada registrada" : "Saída registrada", Toast.LENGTH_SHORT).show();
        });

        builder.setNegativeButton("Cancelar", (dialog, which) -> dialog.dismiss());
        builder.show();
    }

}