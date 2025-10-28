package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.squareup.picasso.Picasso;

import java.util.ArrayList;

public class CustomListView extends ArrayAdapter<String> {

    private Activity context;

    private ArrayList<String> names;
    private ArrayList<String> amounts;
    private ArrayList<String> values;
    private ArrayList<String> photos;

    public CustomListView(Activity context, ArrayList<String> names, ArrayList<String> amounts, ArrayList<String> values, ArrayList<String> photos) {

        super(context, R.layout.custom_listview, names);

        this.context = context;
        this.names = names;
        this.amounts = amounts;
        this.values = values;
        this.photos = photos;

    }

    @Override
    public View getView(int position, View view, ViewGroup parent) {

        LayoutInflater inflater = this.context.getLayoutInflater();
        View rowView = inflater.inflate(R.layout.custom_listview, null, true);

        TextView name = (TextView) rowView.findViewById(R.id.name);
        TextView amount = (TextView) rowView.findViewById(R.id.amount);
        TextView value = (TextView) rowView.findViewById(R.id.value);
        ImageView photo = (ImageView) rowView.findViewById(R.id.photo);
        LinearLayout listLinearLayout = (LinearLayout) rowView.findViewById(R.id.listlinearlayout);

        final int finalPosition = position;

        ImageButton edit = (ImageButton) rowView.findViewById(R.id.edit);
        edit.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                MainActivity.instance.showEditActivity(names.get(finalPosition));
            }
        });

        listLinearLayout.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                MainActivity.instance.showEditActivity(names.get(finalPosition));
            }
        });

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
                if(photos.get(finalPosition) != null && !photos.get(finalPosition).isEmpty() && !photos.get(finalPosition).equals("null")) {
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(Uri.parse("file://" + photos.get(finalPosition)), "image/*");
                    context.startActivity(intent);
                }

            }
        });

        name.setText(names.get(position));
        amount.setText("Quantidade: " + amounts.get(position));
        value.setText("$ " + values.get(position));

        if(photos.get(position) != null && !photos.get(position).isEmpty() && !photos.get(position).equals("null")) {
            Picasso.with(context).load("file://" + photos.get(position)).into(photo);
        }

        return rowView;

    }

}