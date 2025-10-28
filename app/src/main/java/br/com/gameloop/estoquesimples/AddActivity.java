package br.com.gameloop.estoquesimples;

import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.support.v7.app.AppCompatActivity;
import android.os.Bundle;
import android.support.v7.widget.Toolbar;
import android.util.Log;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.Toast;

import com.squareup.picasso.Picasso;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;

public class AddActivity extends AppCompatActivity {

    private EditText productName;
    private EditText productAmount;
    private EditText productValue;
    private EditText productDescription;
    private ImageView productPhoto;

    private String errorFeedback;

    private File imagesFolder;
    private String lastPhotoName;
    private String newPhotoPath;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_add);

        productName = (EditText) findViewById(R.id.addName);
        productAmount = (EditText) findViewById(R.id.addAmount);
        productValue = (EditText) findViewById(R.id.addValue);
        productDescription = (EditText) findViewById(R.id.addDescription);
        productPhoto = (ImageView) findViewById(R.id.addPhoto);

        errorFeedback = "Erros encontrados:\n";

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        this.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);

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

    public void addProduct(View v) {

        if(isValid()) {

            ContentValues insertValues = new ContentValues();
            insertValues.put("name", productName.getText().toString());
            insertValues.put("amount", productAmount.getText().toString());
            insertValues.put("value", productValue.getText().toString());
            insertValues.put("description", productDescription.getText().toString());

            if(newPhotoPath != null) {
                insertValues.put("photo", newPhotoPath);
            }

            MainActivity.stock.insert("Estoque", null, insertValues);

            MainActivity.instance.updateList();

            Toast.makeText(AddActivity.this, "Produto adicionado com sucesso!", Toast.LENGTH_LONG).show();

            finish();

        } else {

            Toast.makeText(AddActivity.this, errorFeedback, Toast.LENGTH_LONG).show();
            errorFeedback = "Erros encontrados:\n";

        }

    }

    public boolean isValid() {

        boolean isValid = true;

        if(productName.getText().toString() == null || productName.getText().toString().isEmpty() || productName.getText().toString().equals("null")) {
            errorFeedback += "\n- Nome do produto é invalido;";
            isValid = false;
        }

        if(MainActivity.instance.productAlreadyExists(productName.getText().toString()) == true) {
            errorFeedback += "\n- Produto com mesmo nome já cadastrado;";
            isValid = false;
        }

        if(productAmount.getText().toString() == null || productAmount.getText().toString().isEmpty() || productAmount.getText().toString().equals("null")) {
            errorFeedback += "\n- Quantidade do produto é invalida;";
            isValid = false;
        }

        if(productValue.getText().toString() == null || productValue.getText().toString().isEmpty() || productValue.getText().toString().equals("null")) {
            errorFeedback += "\n- Valor do produto é invalido;";
            isValid = false;
        }

        return isValid;

    }

    public void cancelAdd(View v) {

        finish();

    }

    public void addTakeCameraPhoto(View v) {

        Intent cameraIntent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());

        imagesFolder = new File(Environment.getExternalStorageDirectory(), "/EstoqueSimples/Imagens");
        imagesFolder.mkdirs();

        lastPhotoName = "es_" + timeStamp + ".png";
        File image = new File(imagesFolder, lastPhotoName);
        Uri uriSavedImage = Uri.fromFile(image);

        cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, uriSavedImage);
        startActivityForResult(cameraIntent, 10);

    }

    public void addTakeGalleryPhoto(View v) {

        Intent i = new Intent(Intent.ACTION_PICK,android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
        startActivityForResult(i, 20);

    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent intent) {

        if (resultCode == RESULT_OK) {

            // Camera photo:
            if (requestCode == 10) {

                File imgFile = new File(imagesFolder, lastPhotoName);

                if (imgFile.exists()) {

                    newPhotoPath = imgFile.getAbsolutePath();
                    Picasso.with(AddActivity.this).load("file://" + newPhotoPath).into(productPhoto);
                    final String finalColumnPhoto = newPhotoPath;
                    productPhoto.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            Intent intent = new Intent(Intent.ACTION_VIEW);
                            intent.setDataAndType(Uri.parse("file://" + finalColumnPhoto), "image/*");
                            startActivity(intent);
                        }
                    });

                }

            }

            // Gallery photo:
            if (requestCode == 20) {

                Uri selectedImage = intent.getData();
                String[] filePathColumn = { MediaStore.Images.Media.DATA };

                Cursor cursor = getContentResolver().query(selectedImage,filePathColumn, null, null, null);
                cursor.moveToFirst();
                int columnIndex = cursor.getColumnIndex(filePathColumn[0]);
                String picturePath = cursor.getString(columnIndex);
                cursor.close();

                if(picturePath.toString() == null || picturePath.isEmpty() || picturePath.equals("null")) {

                    Toast.makeText(AddActivity.this, "Erro ao carregar esta imagem, por favor tente outra.", Toast.LENGTH_SHORT).show();

                } else {

                    newPhotoPath = picturePath;
                    Picasso.with(AddActivity.this).load("file://" + picturePath).into(productPhoto);
                    final String finalColumnPhoto = newPhotoPath;
                    productPhoto.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            Intent intent = new Intent(Intent.ACTION_VIEW);
                            intent.setDataAndType(Uri.parse("file://" + finalColumnPhoto), "image/*");
                            startActivity(intent);
                        }
                    });

                }

            }

        }

    }


}