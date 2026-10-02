package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.analytics.Analytics;

import br.com.gameloop.estoquesimples.data.MovementRepository;
import br.com.gameloop.estoquesimples.data.ProductRepository;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RelativeLayout;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.appcompat.app.AlertDialog;

import com.google.android.material.textfield.TextInputLayout;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

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
    private ArrayList<String> suppliers;
    private ArrayList<String> barcodes;
    private ArrayList<String> descriptions;

    private static final String TAG = "CustomListView";
    private static final String IMAGE_TYPE = "image/*";
    // Expansão guardada por nome, não por posição: a lista é atualizada no
    // lugar depois de cada movimentação/busca e as posições mudam.
    private final Set<String> expandedNames = new HashSet<>();
    private boolean showProductImages;
    /** Tempo do "Desfazer": 8 s ainda escapava a quem lê a mensagem antes de decidir. */
    public static final int UNDO_DURATION_MS = 15000;

    public CustomListView(Activity context, ArrayList<String> names, ArrayList<String> amounts, 
                         ArrayList<String> values, ArrayList<String> photos, ArrayList<String> categories,
                         ArrayList<String> skus, ArrayList<String> locations, 
                         ArrayList<String> minStocks, ArrayList<String> units,
                         ArrayList<String> suppliers, ArrayList<String> barcodes,
                         ArrayList<String> descriptions) {

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
        this.suppliers = suppliers;
        this.barcodes = barcodes;
        this.descriptions = descriptions;
        this.showProductImages = SettingsActivity.isShowProductImages(context);

    }

    public void expand(String name) {
        expandedNames.add(name);
        notifyDataSetChanged();
    }

    /** Relê "Exibir imagens": a configuração não valia até reabrir o app. */
    public void refreshSettings() {
        boolean now = SettingsActivity.isShowProductImages(context);
        if (now != showProductImages) {
            showProductImages = now;
            notifyDataSetChanged();
        }
    }

    public void collapseAll() {
        if (!expandedNames.isEmpty()) {
            expandedNames.clear();
            notifyDataSetChanged();
        }
    }

    @Override
    public View getView(int position, View view, ViewGroup parent) {

        // Reaproveita a linha que saiu da tela em vez de inflar uma nova a
        // cada getView(): com dezenas de produtos, inflar o card inteiro por
        // linha deixava a rolagem engasgada (32% de quadros perdidos no
        // emulador). Todos os campos são preenchidos abaixo, sem estado
        // residual da linha anterior.
        View rowView = view;
        if (rowView == null) {
            LayoutInflater inflater = this.context.getLayoutInflater();
            rowView = inflater.inflate(R.layout.custom_listview, parent, false);
        }

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
        View skuGroup = rowView.findViewById(R.id.skuGroup);
        View categoryGroup = rowView.findViewById(R.id.categoryGroup);

        final int finalPosition = position;

        View edit = rowView.findViewById(R.id.edit);
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
                String key = names.get(finalPosition);
                boolean opening = !expandedNames.remove(key);
                if (opening) {
                    expandedNames.add(key);
                }
                notifyDataSetChanged();
                if (opening && parent instanceof android.widget.ListView) {
                    // Expandir o último card deixava Editar/Excluir abaixo da dobra.
                    final android.widget.ListView list = (android.widget.ListView) parent;
                    list.post(() -> list.smoothScrollToPosition(finalPosition));
                }
            }
        };
        toggleIcon.setOnClickListener(toggleListener);

        View delete = rowView.findViewById(R.id.delete);
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
        
        // Quantidade sempre com a unidade ao lado ("25 un", "3,75 kg"). O
        // formato antigo "25 / 5" (atual / mínimo) era críptico para quem não
        // sabia o que o segundo número significava; o mínimo agora aparece
        // no selo de estoque baixo e nos detalhes.
        // Formata para evitar ".0" em números inteiros (ex.: "18" em vez de "18.0")
        String amountText = CurrencyHelper.formatQuantity(amounts.get(position));
        String minStockStr = minStocks.get(position);
        boolean hasMinStock = minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null") && !minStockStr.equals("0");
        amount.setText(amountText);
        
        // Valor
        double parsedValue = CurrencyHelper.parseCurrency(values.get(position), 0.0);
        value.setText(CurrencyHelper.formatCurrency(context, parsedValue));

        // Configuração de exibição de imagens dos produtos
        RelativeLayout photoContainer = (RelativeLayout) rowView.findViewById(R.id.photoContainer);
        LinearLayout nameContainer = (LinearLayout) rowView.findViewById(R.id.listlinearlayout);
        if (nameContainer != null) {
            nameContainer.setOnClickListener(toggleListener);
        }
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
        boolean hasSku = skus.get(position) != null && !skus.get(position).isEmpty() && !skus.get(position).equals("null");
        if (hasSku) {
            sku.setText(skus.get(position));
        }
        // INVISIBLE (não GONE) quando só a categoria existe: mantém a
        // categoria na mesma coluna dos outros cards.
        boolean categoriaPresente = categories.get(position) != null && !categories.get(position).isEmpty() && !categories.get(position).equals("null");
        skuGroup.setVisibility(hasSku ? View.VISIBLE : (categoriaPresente ? View.INVISIBLE : View.GONE));

        // Categoria
        boolean hasCategory = categories.get(position) != null && !categories.get(position).isEmpty() && !categories.get(position).equals("null");
        if (hasCategory) {
            category.setText(categories.get(position));
        }
        categoryGroup.setVisibility(hasCategory ? View.VISIBLE : View.GONE);

        View metaRow = rowView.findViewById(R.id.metaRow);
        if (metaRow != null) {
            metaRow.setVisibility((hasSku || hasCategory) ? View.VISIBLE : View.GONE);
        }

        // Unidade
        if(units.get(position) != null && !units.get(position).isEmpty() && !units.get(position).equals("null")) {
            unit.setText(" " + units.get(position));
        } else {
            // Cadastro antigo sem unidade: o app já a trata como "un".
            unit.setText(" un");
        }
        unit.setVisibility(View.VISIBLE);

        // Alerta de estoque baixo
        try {
            double currentAmount = CurrencyHelper.parseCurrency(amounts.get(position), 0);
            minStockStr = minStocks.get(position);
            
            if(minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null")) {
                double minStockValue = CurrencyHelper.parseCurrency(minStockStr, 0);
                
                if(minStockValue > 0 && currentAmount <= minStockValue) {
                    lowStockBadge.setText(currentAmount <= 0
                            ? "Sem estoque · mín. " + CurrencyHelper.formatQuantity(minStockStr)
                            : "Estoque baixo · mín. " + CurrencyHelper.formatQuantity(minStockStr));
                    lowStockBadge.setVisibility(View.VISIBLE);
                    amount.setTextColor(ContextCompat.getColor(context, R.color.color_warning));
                } else if (currentAmount <= 0) {
                    lowStockBadge.setText("Sem estoque");
                    lowStockBadge.setVisibility(View.VISIBLE);
                    amount.setTextColor(ContextCompat.getColor(context, R.color.color_warning));
                } else {
                    lowStockBadge.setVisibility(View.GONE);
                    amount.setTextColor(ContextCompat.getColor(context, R.color.color_text));
                }
            } else if (currentAmount <= 0) {
                // Saldo zero é sinalizado mesmo sem mínimo cadastrado.
                lowStockBadge.setText("Sem estoque");
                lowStockBadge.setVisibility(View.VISIBLE);
                amount.setTextColor(ContextCompat.getColor(context, R.color.color_warning));
            } else {
                lowStockBadge.setVisibility(View.GONE);
                amount.setTextColor(ContextCompat.getColor(context, R.color.color_text));
            }
        } catch (NumberFormatException e) {
            lowStockBadge.setVisibility(View.GONE);
            amount.setTextColor(ContextCompat.getColor(context, R.color.color_text));
        }

        // Fração herdada (importação, dado antigo) num produto contado por
        // unidade: "6,5 un" aparecia como normal e contaminava os totais.
        // Os diálogos já barram novas frações; esta sinaliza o que sobrou.
        double saldoAtual = CurrencyHelper.parseCurrency(amounts.get(position), 0);
        if (Unidades.inteira(units.get(position)) && Unidades.fracionada(saldoAtual)) {
            lowStockBadge.setText(lowStockBadge.getVisibility() == View.VISIBLE
                    ? lowStockBadge.getText() + "\nQuantidade quebrada · toque aqui"
                    : "Quantidade quebrada em item por unidade · toque aqui");
            lowStockBadge.setVisibility(View.VISIBLE);
            amount.setTextColor(ContextCompat.getColor(context, R.color.color_warning));
            lowStockBadge.setOnClickListener(v -> MainActivity.instance.showEditActivity(names.get(finalPosition), true));
            lowStockBadge.setClickable(true);
        } else {
            lowStockBadge.setOnClickListener(null);
            lowStockBadge.setClickable(false);
        }

        // Estado expandido/colapsado
        boolean isExpanded = expandedNames.contains(names.get(position));
        extraContainer.setVisibility(isExpanded ? View.VISIBLE : View.GONE);
        // Expandido é o único lugar onde um nome longo aparece inteiro.
        name.setMaxLines(isExpanded ? 8 : 2);
        toggleIcon.setImageResource(isExpanded ? R.drawable.ic_expand_less : R.drawable.ic_expand_more);

        // Campos de detalhes (apenas preenche, a visibilidade da seção é controlada acima)
        TextView detailMinStock = (TextView) rowView.findViewById(R.id.detailMinStock);
        TextView detailDescription = (TextView) rowView.findViewById(R.id.detailDescription);
        TextView detailLocation = (TextView) rowView.findViewById(R.id.detailLocation);
        TextView detailBarcode = (TextView) rowView.findViewById(R.id.detailBarcode);
        TextView detailSupplier = (TextView) rowView.findViewById(R.id.detailSupplier);

        minStockStr = minStocks.get(position);
        if(minStockStr != null && !minStockStr.isEmpty() && !minStockStr.equals("null")) {
            detailMinStock.setText(CurrencyHelper.formatQuantity(minStockStr));
        } else {
            detailMinStock.setText("-");
        }

        // A unidade já aparece ao lado da quantidade; a descrição não aparecia
        // em lugar nenhum da lista.
        String descriptionStr = descriptions == null ? null : descriptions.get(position);
        detailDescription.setText(descriptionStr != null && !descriptionStr.trim().isEmpty()
                && !descriptionStr.equals("null") ? descriptionStr.trim() : "-");

        String locationStr = locations.get(position);
        if(locationStr != null && !locationStr.isEmpty() && !locationStr.equals("null")) {
            detailLocation.setText(locationStr);
        } else {
            detailLocation.setText("-");
        }

        // SKU e categoria já estão no cabeçalho; aqui entra o que faltava.
        String barcodeStr = barcodes == null ? null : barcodes.get(position);
        detailBarcode.setText(barcodeStr != null && !barcodeStr.isEmpty() && !barcodeStr.equals("null")
                ? barcodeStr : "-");
        String supplierStr = suppliers == null ? null : suppliers.get(position);
        detailSupplier.setText(supplierStr != null && !supplierStr.isEmpty() && !supplierStr.equals("null")
                ? supplierStr : "-");

        // Ações de estoque (Entrada / Saída): visíveis sem expandir o card,
        // porque são a tarefa do dia a dia. Editar/excluir ficam nos detalhes.
        View btnEntrada = rowView.findViewById(R.id.btnEntrada);
        View btnSaida = rowView.findViewById(R.id.btnSaida);

        if (btnEntrada != null) {
            btnEntrada.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showStockDialog(finalPosition, true);
                }
            });
        }

        if (btnSaida != null) {
            // Sem saldo não há o que dar baixa: o botão avisa em vez de abrir um
            // diálogo que só vai recusar a quantidade.
            final boolean semEstoque = CurrencyHelper.parseCurrency(amounts.get(position), 0) <= 0;
            btnSaida.setAlpha(semEstoque ? 0.4f : 1f);
            btnSaida.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (semEstoque) {
                        if (MainActivity.instance != null) {
                            MainActivity.instance.releaseSearchFocus();
                        }
                        com.google.android.material.snackbar.Snackbar aviso = Feedback.make(context,
                                "Sem estoque para dar saída. Registre uma entrada primeiro.",
                                com.google.android.material.snackbar.Snackbar.LENGTH_LONG);
                        if (aviso != null) {
                            aviso.setDuration(6000);
                            aviso.setAction("Entrada", v2 -> showStockDialog(finalPosition, true));
                            aviso.show();
                        }
                        return;
                    }
                    showStockDialog(finalPosition, false);
                }
            });
        }

        return rowView;

    }

    private void showStockDialog(int position, boolean isEntrada) {
        String productName = names.get(position);
        double saldoAtual = CurrencyHelper.parseCurrency(amounts.get(position), 0);
        if (Unidades.inteira(units.get(position)) && Unidades.fracionada(saldoAtual)) {
            // Movimentar por cima de um saldo quebrado só espalha o erro.
            com.google.android.material.snackbar.Snackbar aviso = Feedback.make(context,
                    "Este produto está com " + CurrencyHelper.formatQuantity(saldoAtual)
                            + " " + units.get(position) + ". Corrija a quantidade antes de movimentar.",
                    com.google.android.material.snackbar.Snackbar.LENGTH_LONG);
            if (aviso != null) {
                aviso.setDuration(8000);
                aviso.setAction("Corrigir", v -> MainActivity.instance.showEditActivity(productName, true));
                aviso.show();
            }
            return;
        }

        AlertDialog.Builder builder = new AlertDialog.Builder(context);
        builder.setTitle(isEntrada ? "Entrada de estoque" : "Saída de estoque");
        // Saldo atual no próprio diálogo: quem dá baixa precisa saber quanto
        // tem antes de digitar, em vez de descobrir pelo erro depois.
        String unitStr = units.get(position);
        boolean hasUnit = unitStr != null && !unitStr.isEmpty() && !unitStr.equals("null");
        String currentText = CurrencyHelper.formatQuantity(amounts.get(position))
                + (hasUnit ? " " + unitStr : "");
        builder.setMessage(productName + "\nEm estoque: " + currentText);

        LinearLayout container = new LinearLayout(context);
        container.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (context.getResources().getDisplayMetrics().density * 16);
        container.setPadding(padding, padding, padding, padding);

        final boolean unidadeInteira = Unidades.inteira(units.get(position));
        // Produto contado por unidade: a fração é barrada na validação, com
        // mensagem. Tirar a vírgula do teclado fazia "1,5" virar "15" em silêncio.
        TextInputLayout qtyLayout = FormValidation.addField(container, "Quantidade",
                android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
                        | android.text.InputType.TYPE_NUMBER_FLAG_SIGNED);

        String noteHint = "Observação (opcional)";
        int noteInputType = android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                | (isEntrada ? 0 : android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        TextInputLayout noteLayout = FormValidation.addField(container, noteHint, noteInputType);
        LinearLayout.LayoutParams noteLayoutParams =
                (LinearLayout.LayoutParams) noteLayout.getLayoutParams();
        noteLayoutParams.topMargin = (int) (context.getResources().getDisplayMetrics().density * 8);
        noteLayout.setLayoutParams(noteLayoutParams);
        final EditText inputNote = noteLayout.getEditText();
        if (!isEntrada && inputNote != null) {
            // Saída para o cliente: campo de informações adicionais mais completo
            inputNote.setMinLines(2);
            inputNote.setMaxLines(6);
            inputNote.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        }

        // Data opcional: registrar a compra de ontem com a data de hoje deixava
        // o histórico e o PDF por período errados.
        final long[] quando = {0L};
        final android.widget.TextView dataView = new android.widget.TextView(context);
        dataView.setText("Data: agora · alterar");
        dataView.setTextColor(ContextCompat.getColor(context, R.color.color_brand));
        dataView.setTypeface(null, android.graphics.Typeface.BOLD);
        dataView.setPadding(0, (int) (context.getResources().getDisplayMetrics().density * 12), 0, 0);
        dataView.setOnClickListener(v -> {
            java.util.Calendar cal = java.util.Calendar.getInstance();
            if (quando[0] > 0) cal.setTimeInMillis(quando[0]);
            android.app.DatePickerDialog picker = new android.app.DatePickerDialog(context, (dp, y, m, d) -> {
                java.util.Calendar escolhido = java.util.Calendar.getInstance();
                escolhido.set(y, m, d, 12, 0, 0);
                long hoje = System.currentTimeMillis();
                if (escolhido.getTimeInMillis() > hoje) {
                    escolhido.setTimeInMillis(hoje);
                }
                boolean eHoje = android.text.format.DateUtils.isToday(escolhido.getTimeInMillis());
                quando[0] = eHoje ? 0L : escolhido.getTimeInMillis();
                dataView.setText(eHoje ? "Data: agora · alterar"
                        : "Data: " + new java.text.SimpleDateFormat("dd/MM/yyyy", java.util.Locale.getDefault())
                        .format(new java.util.Date(quando[0])) + " · alterar");
            }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH));
            picker.getDatePicker().setMaxDate(System.currentTimeMillis());
            picker.show();
        });
        container.addView(dataView);

        builder.setView(container);
        builder.setNegativeButton("Cancelar", (dialog, which) -> dialog.dismiss());
        // Listener sobrescrito depois do show(): assim o clique não fecha o
        // diálogo sozinho (e perde o que já foi digitado) quando algo falha.
        builder.setPositiveButton("Confirmar", null);

        AlertDialog dialog = builder.create();
        // Quantidade já em foco, com teclado: é o único campo obrigatório e
        // cada movimentação exigia um toque a mais. STATE_VISIBLE depois do
        // show() não bastava; o modo precisa estar na janela antes de ela
        // aparecer, e o showSoftInput cobre o teclado que ainda assim não vier.
        if (dialog.getWindow() != null) {
            dialog.getWindow().setSoftInputMode(
                    android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        }
        dialog.show();
        final EditText qtyField = qtyLayout.getEditText();
        if (qtyField != null) {
            qtyField.requestFocus();
            qtyField.post(() -> {
                android.view.inputmethod.InputMethodManager imm = (android.view.inputmethod.InputMethodManager)
                        context.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) {
                    imm.showSoftInput(qtyField, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                }
            });
        }
        // Fechar o diálogo com o teclado aberto devolvia o teclado para a
        // busca da lista. Quem fecha o teclado é a lista, sempre.
        dialog.setOnDismissListener(d -> {
            if (MainActivity.instance != null) {
                MainActivity.instance.releaseSearchFocus();
            }
        });
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String qtyStr = qtyLayout.getEditText().getText().toString().trim();
            if (!FormValidation.required(qtyLayout, "Informe a quantidade.")) {
                return;
            }
            double qty = CurrencyHelper.parseCurrency(qtyStr, -1);
            if (!FormValidation.check(qtyLayout, qty <= 0, "A quantidade deve ser maior que zero.")) {
                return;
            }
            if (!FormValidation.check(qtyLayout, unidadeInteira && Unidades.fracionada(qty),
                    Unidades.mensagemFracao(units.get(position)))) {
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
            String note = inputNote == null ? "" : inputNote.getText().toString().trim();

            MovementRepository.Result result;
            synchronized (MainActivity.DB_LOCK) {
                result = movements.apply(
                        productUuid,
                        isEntrada ? MovementRepository.ENTRADA : MovementRepository.SAIDA,
                        isEntrada ? qty : -qty,
                        note,
                        quando[0]);
            }

            if (!result.success) {
                // Erro no próprio campo: um Toast ficava escondido atrás do
                // diálogo e sumia antes de ser lido.
                FormValidation.check(qtyLayout, true, result.message);
                return;
            }

            Analytics.track(getContext(), "movement.created",
                    Analytics.props("type", isEntrada ? MovementRepository.ENTRADA : MovementRepository.SAIDA));
            dialog.dismiss();

            // Atualizar lista
            if (MainActivity.instance != null) {
                // Com o filtro "Estoque baixo" ligado, o produto que acabou de
                // receber entrada sumia da lista no mesmo instante.
                MainActivity.instance.keepVisible(productName);
                MainActivity.instance.updateList();
            }
            showMovementSnackbar(isEntrada, qty, unitStr, hasUnit, result, quando[0]);
        });
    }

    /**
     * Confirmação da movimentação com "Desfazer". Um Toast sumia em dois
     * segundos por cima da barra de navegação e, se a pessoa errou o número,
     * a única saída era achar o registro no Histórico e estorná-lo. O
     * desfazer usa o mesmo estorno estruturado do Histórico (fica
     * registrado; nada é apagado).
     */
    private void showMovementSnackbar(boolean isEntrada, double qty, String unitStr, boolean hasUnit,
                                      MovementRepository.Result result, long quando) {
        // \u00a0 entre número e unidade: "kg" sozinho na linha de baixo lia mal.
        String data = quando > 0
                ? " em " + new java.text.SimpleDateFormat("dd/MM", java.util.Locale.getDefault()).format(new java.util.Date(quando))
                : "";
        String text = (isEntrada ? "Entrada de " : "Saída de ")
                + CurrencyHelper.formatQuantity(qty) + (hasUnit ? "\u00a0" + unitStr : "")
                + data + " registrada. Estoque agora: " + CurrencyHelper.formatQuantity(result.newAmount)
                + (hasUnit ? "\u00a0" + unitStr : "");
        com.google.android.material.snackbar.Snackbar snackbar = Feedback.make(context, text,
                com.google.android.material.snackbar.Snackbar.LENGTH_LONG);
        if (snackbar == null) {
            return;
        }
        if (result.movementUuid != null) {
            snackbar.setAction("Desfazer", v -> {
                MovementRepository.Result undo;
                synchronized (MainActivity.DB_LOCK) {
                    undo = new MovementRepository(MainActivity.stock)
                            .cancel(result.movementUuid, "Desfeita logo após o registro");
                }
                if (MainActivity.instance != null) {
                    MainActivity.instance.updateList();
                }
                Feedback.show(context, undo.success
                        ? "Desfeito. Estoque de volta a " + CurrencyHelper.formatQuantity(undo.newAmount)
                                + (hasUnit ? "\u00a0" + unitStr : "") + "."
                        : (undo.message == null ? "Não foi possível desfazer." : undo.message));
            });
        }
        // Tempo para ler e decidir: com os 3 s padrão o "Desfazer" sumia antes
        // do segundo toque, que caía no card de trás.
        snackbar.setDuration(UNDO_DURATION_MS);
        snackbar.show();
    }

}