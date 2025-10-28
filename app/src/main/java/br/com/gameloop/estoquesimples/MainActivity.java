package br.com.gameloop.estoquesimples;

import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.support.v4.content.ContextCompat;
import android.support.v7.app.AlertDialog;
import android.support.v7.app.AppCompatActivity;
import android.os.Bundle;
import android.text.Html;
import android.widget.Button;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import com.kobakei.ratethisapp.RateThisApp;
import com.luseen.luseenbottomnavigation.BottomNavigation.BottomNavigationItem;
import com.luseen.luseenbottomnavigation.BottomNavigation.BottomNavigationView;
import com.luseen.luseenbottomnavigation.BottomNavigation.OnBottomNavigationItemClickListener;

import java.util.ArrayList;

public class MainActivity extends AppCompatActivity {

    public static MainActivity instance;

    public static SQLiteDatabase stock;

    public ListView listView;
    public TextView emptyListItem;
    public CustomListView listAdapter;

    public ArrayList<String> names;
    public ArrayList<String> descriptions;
    public ArrayList<String> amounts;
    public ArrayList<String> values;
    public ArrayList<String> photos;

    public BottomNavigationView bottomNavigationView;

    public SharedPreferences prefs;
    public SharedPreferences.Editor prefsEditor;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        emptyListItem = (TextView) findViewById(R.id.empty_list_item);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            emptyListItem.setText(Html.fromHtml("<b>Nenhum produto cadastrado no momento :(</b><br>Você pode começar adicionando um novo cadastro no botão <b>Novo Produto</b>" , Html.FROM_HTML_MODE_LEGACY));
        } else {
            emptyListItem.setText(Html.fromHtml("<b>Nenhum produto cadastrado no momento :(</b><br>Você pode começar adicionando um novo cadastro no botão <b>Novo Produto</b>"));
        }

        instance = this;

        openOrCreateDB();
        prepareList();
        getListValues();
        updateList();

        // Bottom Menu:

        bottomNavigationView = (BottomNavigationView) findViewById(R.id.bottomNavigation);

        bottomNavigationView.isWithText(true);
        bottomNavigationView.setTextActiveSize(18f);
        bottomNavigationView.setTextInactiveSize(18f);

        BottomNavigationItem bottomNavigationItem0 = new BottomNavigationItem
                ("Inicio", ContextCompat.getColor(this, R.color.colorActionBar), R.drawable.home_icon);

        BottomNavigationItem bottomNavigationItem1 = new BottomNavigationItem
                ("Novo Produto", ContextCompat.getColor(this, R.color.colorActionBar), R.drawable.new_icon);

        BottomNavigationItem bottomNavigationItem2 = new BottomNavigationItem
                ("Relatórios", ContextCompat.getColor(this, R.color.colorActionBar), R.drawable.report_icon);

        BottomNavigationItem bottomNavigationItem3 = new BottomNavigationItem
                ("Importar", ContextCompat.getColor(this, R.color.colorActionBar), R.drawable.import_icon);

        bottomNavigationView.addTab(bottomNavigationItem0);
        bottomNavigationView.addTab(bottomNavigationItem1);
        bottomNavigationView.addTab(bottomNavigationItem2);
        bottomNavigationView.addTab(bottomNavigationItem3);

        bottomNavigationView.setOnBottomNavigationItemClickListener(new OnBottomNavigationItemClickListener() {
            @Override
            public void onNavigationItemClick(int index) {

                switch (index) {
                    case 0:
                        break;
                    case 1:
                        showAddActivity();
                        break;
                    case 2:
                        showReportsActivity();
                        break;
                    case 3:
                        showImportActivity();
                        break;
                }

            }
        });

        bottomNavigationView.setBackgroundColor(ContextCompat.getColor(getApplicationContext(), R.color.colorActionBar));

        prefs = getApplicationContext().getSharedPreferences("EstoqueSimplesPrefs", 0);

        if(prefs.getBoolean("welcomeMsgAlreadyDisplayed", false) == false) {

            showWelcomeMessage();
            prefsEditor = prefs.edit();
            prefsEditor.putBoolean("welcomeMsgAlreadyDisplayed", true);
            prefsEditor.commit();

        } else {

            RateThisApp.Config config = new RateThisApp.Config(3, 5);
            config.setTitle(R.string.my_own_title);
            config.setMessage(R.string.my_own_message);
            config.setYesButtonText(R.string.my_own_rate);
            config.setNoButtonText(R.string.my_own_thanks);
            config.setCancelButtonText(R.string.my_own_cancel);
            RateThisApp.init(config);

            RateThisApp.setCallback(new RateThisApp.Callback() {
                @Override
                public void onYesClicked() {
                    RateThisApp.stopRateDialog(MainActivity.this);
                }

                @Override
                public void onNoClicked() {
                    RateThisApp.stopRateDialog(MainActivity.this);
                }

                @Override
                public void onCancelClicked() {
                    RateThisApp.stopRateDialog(MainActivity.this);
                }
            });
        }

    }

    public void openOrCreateDB() {

        stock = openOrCreateDatabase("estoque", MODE_PRIVATE, null);
        stock.execSQL("CREATE TABLE IF NOT EXISTS Estoque(id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR, description VARCHAR, amount VARCHAR, value VARCHAR, photo VARCHAR);");

    }


    public void prepareList() {

        names = new ArrayList<String>();
        descriptions = new ArrayList<String>();
        amounts = new ArrayList<String>();
        values = new ArrayList<String>();
        photos = new ArrayList<String>();

        listAdapter = new CustomListView(this, names, amounts, values, photos);

        listView = (ListView) findViewById(R.id.listView);
        listView.setEmptyView(findViewById(R.id.empty_list_item));
        listView.setAdapter(listAdapter);

    }

    @Override
    protected void onResume() {
        super.onResume();
        bottomNavigationView.selectTab(0);
    }

    public void updateList() {

        getListValues();

        listAdapter = new CustomListView(this, names, amounts, values, photos);
        listView.setAdapter(listAdapter);
        listAdapter.notifyDataSetChanged();

    }

    public void getListValues() {

        clearArrays();

        Cursor cursor = stock.rawQuery("SELECT name, description, amount, value, photo FROM Estoque", null);

        if(cursor.moveToFirst()) {

            do {

                String columnName = cursor.getString(0);
                String columnDescription = cursor.getString(1);
                String columnAmount = cursor.getString(2);
                String columnValue = cursor.getString(3);
                String columnPhoto = cursor.getString(4);

                names.add(columnName);
                descriptions.add(columnDescription);
                amounts.add(columnAmount);
                values.add(columnValue);
                photos.add(columnPhoto);

            } while (cursor.moveToNext());

        }

        cursor.close();

    }

    public void clearArrays() {

        names.clear();
        descriptions.clear();
        amounts.clear();
        values.clear();
        photos.clear();

    }

    public void deleteProduct(String productName) {

        final String finalProductName = productName;

        new AlertDialog.Builder(this)
                .setTitle("Atenção")
                .setMessage("Tem certeza que deseja remover o item '" + productName + "'?")
                .setIcon(R.drawable.delete_icon)
                .setPositiveButton(android.R.string.yes, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int whichButton) {
                        stock.execSQL("DELETE FROM Estoque WHERE name='" + finalProductName + "'");
                        updateList();
                        Toast.makeText(MainActivity.this, "Produto removido com sucesso!", Toast.LENGTH_LONG).show();
                    }})
                .setNegativeButton(android.R.string.no, null).show();

    }

    public boolean productAlreadyExists(String productName) {

        Cursor cursor = stock.rawQuery("SELECT * FROM Estoque WHERE name='" + productName + "'", null);
        int count = cursor.getCount();
        cursor.close();

        if(count > 0) {
            return true;
        } else {
            return false;
        }

    }

    public void showAddActivity() {

        Intent intent = new Intent(this, AddActivity.class);
        startActivity(intent);

    }

    public void showEditActivity(String productName) {

        Intent intent = new Intent(this, EditActivity.class);
        intent.putExtra("productName", productName);
        startActivity(intent);

    }

    public void showReportsActivity() {

        Intent intent = new Intent(this, ReportsActivity.class);
        startActivity(intent);

    }

    public void showImportActivity() {

        Intent intent = new Intent(this, ImportActivity.class);
        startActivity(intent);

    }

    public void showWelcomeMessage() {

        AlertDialog alertDialog = new AlertDialog.Builder(MainActivity.this).create();
        alertDialog.setTitle("Seja Bem-Vindo!");
        alertDialog.setMessage("Esperamos que goste do aplicativo e que ele seja muito útil para você, em caso de dúvidas ou problemas por favor entre em contato conosco ;)\n\nwww.gameloop.com.br");
        alertDialog.setButton(AlertDialog.BUTTON_NEUTRAL, "Ok",
                new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int which) {
                        dialog.dismiss();
                    }
                });
        alertDialog.show();

    }

    @Override
    protected void onStart() {
        super.onStart();

        RateThisApp.onStart(this);
        RateThisApp.showRateDialogIfNeeded(this);

    }

}
