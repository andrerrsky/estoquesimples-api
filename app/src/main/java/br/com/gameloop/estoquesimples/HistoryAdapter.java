package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class HistoryAdapter extends BaseAdapter {

    public static class HistoryItem {
        private String uuid;
        private String productName;
        private String type;
        private double quantity;
        private long timestamp;
        private String note;

        public HistoryItem(String uuid, String productName, String type, double quantity,
                           long timestamp, String note) {
            this.uuid = uuid;
            this.productName = productName;
            this.type = type;
            this.quantity = quantity;
            this.timestamp = timestamp;
            this.note = note;
        }

        public String getUuid() {
            return uuid;
        }

        public String getProductName() {
            return productName;
        }

        public String getType() {
            return type;
        }

        public double getQuantity() {
            return quantity;
        }

        public long getTimestamp() {
            return timestamp;
        }

        public String getNote() {
            return note;
        }
    }

    private Context context;
    private List<HistoryItem> items;

    public HistoryAdapter(Context context, List<HistoryItem> items) {
        this.context = context;
        this.items = items;
    }

    @Override
    public int getCount() {
        return items.size();
    }

    @Override
    public Object getItem(int position) {
        return items.get(position);
    }

    @Override
    public long getItemId(int position) {
        return position;
    }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        ViewHolder holder;

        if (convertView == null) {
            convertView = LayoutInflater.from(context).inflate(R.layout.history_item, parent, false);
            holder = new ViewHolder();
            holder.typeBadge = convertView.findViewById(R.id.typeBadge);
            holder.typeSign = convertView.findViewById(R.id.typeSign);
            holder.typeLabel = convertView.findViewById(R.id.typeLabel);
            holder.productName = convertView.findViewById(R.id.productName);
            holder.quantity = convertView.findViewById(R.id.quantity);
            holder.dateTime = convertView.findViewById(R.id.dateTime);
            holder.note = convertView.findViewById(R.id.note);
            convertView.setTag(holder);
        } else {
            holder = (ViewHolder) convertView.getTag();
        }

        HistoryItem item = items.get(position);

        holder.typeSign.setText(MovementDisplay.sign(item.getType(), item.getQuantity()));
        holder.typeLabel.setText(MovementDisplay.label(item.getType()));
        holder.typeBadge.setBackgroundColor(MovementDisplay.color(item.getType(), item.getQuantity()));

        // Nome do produto
        holder.productName.setText(item.getProductName());

        // Quantidade
        // O sinal já está no selo ao lado; repeti-lo no número mostraria "--5".
        holder.quantity.setText(CurrencyHelper.formatQuantity(Math.abs(item.getQuantity())));

        // Data e hora
        String dateStr = new SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault()).format(new Date(item.getTimestamp()));
        holder.dateTime.setText(dateStr);

        // Observações
        String note = item.getNote();
        if (note != null && !note.isEmpty() && !"null".equals(note)) {
            holder.note.setText(note);
            holder.note.setVisibility(View.VISIBLE);
        } else {
            holder.note.setVisibility(View.GONE);
        }

        return convertView;
    }

    static class ViewHolder {
        LinearLayout typeBadge;
        TextView typeSign;
        TextView typeLabel;
        TextView productName;
        TextView quantity;
        TextView dateTime;
        TextView note;
    }
}

