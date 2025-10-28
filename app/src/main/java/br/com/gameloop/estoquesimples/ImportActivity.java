package br.com.gameloop.estoquesimples;

import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import android.os.Environment;
import android.support.v7.app.AlertDialog;
import android.support.v7.app.AppCompatActivity;
import android.text.Html;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.text.SimpleDateFormat;
import java.util.Date;

public class ImportActivity extends AppCompatActivity {

    public TextView status;
    public TextView importDesc2;
    public TextView importExportDesc;
    public String statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_import);

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        status = (TextView) findViewById(R.id.importStatus);
        importDesc2 = (TextView) findViewById(R.id.importDesc2);
        importExportDesc = (TextView) findViewById(R.id.importExportDesc);

        statusText = "Log:\n\n";

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            importDesc2.setText(Html.fromHtml("<b>Nome, Descrição, Quantidade, Valor</b><br>Separados por vírgulas simples<br>Sendo <b>1</b> item por linha<br>Formatos <b>.txt</b> ou <b>.csv</b>" , Html.FROM_HTML_MODE_LEGACY));
        } else {
            importDesc2.setText(Html.fromHtml("<b>Nome, Descrição, Quantidade, Valor</b><br>Separados por vírgulas simples<br>Sendo <b>1</b> item por linha<br>Formatos <b>.txt</b> ou <b>.csv</b>"));
        }

        showImportMessage();

    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case android.R.id.home:
                onBackPressed();
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    public void importFile(View v) {

        statusText = "";

        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("text/plain,text/csv");

        try {
            startActivityForResult(intent, 55);
        } catch (android.content.ActivityNotFoundException ex) {
            Toast.makeText(this, "Por favor, instale um aplicativo gerenciador de arquivos.", Toast.LENGTH_SHORT).show();
        }

    }

    public void importDBFile(View v) {

        new AlertDialog.Builder(this)
                .setTitle("Atenção")
                .setMessage("Se você importar um outro banco de dados o atual será perdido, tem certeza que deseja fazer isso?")
                .setIcon(android.R.drawable.ic_dialog_alert)
                .setPositiveButton(R.string.sim, new DialogInterface.OnClickListener() {

                    public void onClick(DialogInterface dialog, int whichButton) {

                        statusText = "";

                        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                        intent.setType("file/db");

                        try {
                            startActivityForResult(intent, 22);
                        } catch (android.content.ActivityNotFoundException ex) {
                            Toast.makeText(ImportActivity.this, "Por favor, instale um aplicativo gerenciador de arquivos.", Toast.LENGTH_SHORT).show();
                        }

                    }})

                .setNegativeButton(android.R.string.cancel, null).show();

    }


    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent intent) {

        if (resultCode == RESULT_OK) {

            statusText = "Log:\n\n";

            // DB Import:
            if (requestCode == 22) {
                importDBFileProcess(intent.getData().getPath());
            }

            // File Import:
            if (requestCode == 55) {

                Toast.makeText(ImportActivity.this, "Importando...", Toast.LENGTH_SHORT).show();

                File file = new File (intent.getData().getPath());
                StringBuilder resultado = new StringBuilder();

                try {

                    BufferedReader br = new BufferedReader(new FileReader(file));
                    String line;

                    int lineCounter = 0;

                    while ((line = br.readLine()) != null) {
                        lineCounter ++;
                        String[] separated = line.split(",");
                        addImportedItem(separated);
                    }
                    br.close();

                    if(lineCounter <= 0) {
                        statusText = "Nenhum item encontrado :(";
                    } else {
                        statusText += "(" + lineCounter + ") itens encontrados :)\n\n";
                    }

                    status.setText(statusText);

                }
                catch (IOException e) {

                    Toast.makeText(ImportActivity.this, "Erro ao importar arquivo: " + e.toString(), Toast.LENGTH_SHORT).show();
                    statusText += "Erro ao importar arquivo: " + e.toString();

                }



            }

        }

    }

    public void addImportedItem(String[] separated) {

        String name = separated[0];

        if(MainActivity.instance.productAlreadyExists(name) == false && name != null && name.equals("null") == false && name.isEmpty() == false) {

            String description = separated[1];
            String amount = separated[2];
            String value = separated[3];

            if(description == null && description.equals("null") == true && name.isEmpty() == true) {
                description = "";
            }

            if(amount == null && amount.equals("null") == true && amount.isEmpty() == true) {
                amount = "0";
            }

            if(value == null && value.equals("null") == true && value.isEmpty() == true) {
                value = "0";
            }

            addProduct(name, description, amount, value);

        }  else {

            statusText += name + " não foi adicionado porque já existe um produto com esse nome.\n\n";

        }

    }

    public void addProduct(String name, String description, String amount, String value) {

        ContentValues insertValues = new ContentValues();
        insertValues.put("name", name);
        insertValues.put("amount", amount);
        insertValues.put("value", value);
        insertValues.put("description", description);

        MainActivity.stock.insert("Estoque", null, insertValues);

        MainActivity.instance.updateList();

    }

    public void exportDBFile(View view) {

        File sd = Environment.getExternalStorageDirectory();

        if (sd.canWrite()) {

            try {

                Date curDate = new Date();
                SimpleDateFormat simpleDate = new SimpleDateFormat("dd-M-yyyy_hh-mm-ss");
                String strDt = simpleDate.format(curDate);

                File fout = new File(Environment.getExternalStorageDirectory() + "/EstoqueSimples/Bancos de Dados/");
                fout.mkdirs();

                File f = new File("/data/data/br.com.gameloop.estoquesimples/databases/estoque");
                FileInputStream fis = new FileInputStream(f);
                FileOutputStream fos = new FileOutputStream(Environment.getExternalStorageDirectory() + "/EstoqueSimples/Bancos de Dados/EstoqueSimples_" + strDt + ".db");

                while (true) {

                    int i = fis.read();

                    if (i != -1) {

                        fos.write(i);

                    } else {
                        break;
                    }

                }

                fos.flush();

                importExportDesc.setText("Banco de dados exportado com sucesso!\n\nSalvo em: /EstoqueSimples/Bancos de Dados/EstoqueSimples_" + strDt + ".db no seu Cartão SD.");
                Toast.makeText(ImportActivity.this, "Banco de dados exportado com sucesso!", Toast.LENGTH_SHORT).show();

                fos.close();
                fis.close();

            } catch (IOException e) {

                importExportDesc.setText("Erro ao exportar: " + e.getMessage());
                Toast.makeText(ImportActivity.this, "Ocorreu um erro ao exportar o banco de dados.", Toast.LENGTH_SHORT).show();

            }

        } else {

            importExportDesc.setText("Erro ao tentar exportar para seu cartão SD, por favor verifique.");
            Toast.makeText(ImportActivity.this, "Ocorreu um erro ao exportar o banco de dados.", Toast.LENGTH_SHORT).show();

        }

    }

    public void importDBFileProcess(String newDBPath) {

        File sd = Environment.getExternalStorageDirectory();

        if (sd.canRead() && newDBPath != null) {

            try {

                String currentDBPath = "/data/data/br.com.gameloop.estoquesimples/databases/estoque";

                File newDB = new File(newDBPath);
                File currentDB = new File(currentDBPath);

                FileChannel src = new FileInputStream(newDB).getChannel();
                FileChannel dst = new FileOutputStream(currentDB).getChannel();

                dst.transferFrom(src, 0, src.size());

                src.close();
                dst.close();

                MainActivity.instance.openOrCreateDB();
                MainActivity.instance.prepareList();
                MainActivity.instance.getListValues();
                MainActivity.instance.updateList();

                importExportDesc.setText("Banco de dados importado com sucesso!\n\nOs produtos já estão disponiveis na lista.");
                Toast.makeText(ImportActivity.this, "Banco de dados importado com sucesso!", Toast.LENGTH_SHORT).show();


            } catch (Exception e) {

                importExportDesc.setText("Erro ao importar: " + e.getMessage());
                Toast.makeText(ImportActivity.this, "Ocorreu um erro ao importar o banco de dados.", Toast.LENGTH_SHORT).show();

            }


        } else {

            importExportDesc.setText("Erro ao tentar importar do seu cartão SD, por favor verifique.");
            Toast.makeText(ImportActivity.this, "Ocorreu um erro ao importar o banco de dados.", Toast.LENGTH_SHORT).show();

        }

    }

    public void showImportMessage() {

        AlertDialog alertDialog = new AlertDialog.Builder(ImportActivity.this).create();
        alertDialog.setTitle("Atenção");
        alertDialog.setMessage("Para importar arquivos é necessário que você possua um aplicativo de gerenciamento de arquivos.");
        alertDialog.setButton(AlertDialog.BUTTON_NEUTRAL, "Ok",
                new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface dialog, int which) {
                        dialog.dismiss();
                    }
                });
        alertDialog.show();

    }


}
