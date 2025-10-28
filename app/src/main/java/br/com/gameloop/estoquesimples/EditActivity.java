package br.com.gameloop.estoquesimples;

import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.support.v7.app.AppCompatActivity;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import com.squareup.picasso.Picasso;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;

public class EditActivity extends AppCompatActivity {

    private ImageView photo;
    private TextView name;
    private TextView amount;
    private TextView value;
    private TextView description;

    private String errorFeedback;

    public String productName;

    private File imagesFolder;
    private String lastPhotoName;
    private Bitmap receivedBitmap;
    private String newPhotoPath;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_edit);

        productName = null;
        newPhotoPath = null;

        if (getIntent().hasExtra("productName")) {
            productName = getIntent().getStringExtra("productName");
        } else {
            Toast.makeText(EditActivity.this, "Erro ao editar produto.", Toast.LENGTH_SHORT).show();
            finish();
        }

        photo = (ImageView) findViewById(R.id.editPhoto);
        name = (TextView) findViewById(R.id.editName);
        amount = (TextView) findViewById(R.id.editAmount);
        value = (TextView) findViewById(R.id.editValue);
        description = (TextView) findViewById(R.id.editDescription);

        errorFeedback = "Erros encontrados:\n";

        name.setText(productName);

        getItemValuesByName(productName);

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

    private void getItemValuesByName(String productName) {

        Cursor cursor = MainActivity.stock.rawQuery("SELECT description, amount, value, photo FROM Estoque WHERE name='" + productName + "'", null);

        if(cursor.moveToFirst()) {

            do {

                String columnDescription = cursor.getString(0);
                String columnAmount = cursor.getString(1);
                String columnValue = cursor.getString(2);
                String columnPhoto = cursor.getString(3);

                description.setText(columnDescription);
                amount.setText(columnAmount);
                value.setText(columnValue);

                if(columnPhoto != null && !columnPhoto.isEmpty() && !columnPhoto.equals("null")) {

                    photo.setImageBitmap(BitmapFactory.decodeFile(columnPhoto));
                    final String finalColumnPhoto = columnPhoto;
                    photo.setOnClickListener(new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            Intent intent = new Intent(Intent.ACTION_VIEW);
                            intent.setDataAndType(Uri.parse("file://" + finalColumnPhoto), "image/*");
                            startActivity(intent);
                        }
                    });

                }

            } while (cursor.moveToNext());

        }

        cursor.close();

    }

    public void cancelEdit(View v) {
        finish();
    }

    public void editProduct(View v) {

        if(isValid()) {

            ContentValues updateValues = new ContentValues();
            updateValues.put("name", name.getText().toString());
            updateValues.put("amount", amount.getText().toString().replace(" ", ""));
            updateValues.put("value", value.getText().toString().replace(" ", ""));
            updateValues.put("description", description.getText().toString());

            if(newPhotoPath != null) {
                updateValues.put("photo", newPhotoPath);
            }

            MainActivity.stock.update("Estoque", updateValues, "name='"+productName+"'", null);

            MainActivity.instance.updateList();

            Toast.makeText(EditActivity.this, "Produto atualizado com sucesso.", Toast.LENGTH_SHORT).show();

            finish();

        } else {

            Toast.makeText(EditActivity.this, errorFeedback, Toast.LENGTH_LONG).show();
            errorFeedback = "Erros encontrados:\n";

        }

    }

    public boolean isValid() {

        boolean isValid = true;

        if(name.getText().toString() == null || name.getText().toString().isEmpty() || name.getText().toString().equals("null")) {
            errorFeedback += "\n- Nome do produto é invalido;";
            isValid = false;
        }

        if(amount.getText().toString() == null || amount.getText().toString().isEmpty() || amount.getText().toString().equals("null")) {
            errorFeedback += "\n- Quantidade do produto é invalida;";
            isValid = false;
        }

        if(value.getText().toString() == null || value.getText().toString().isEmpty() || value.getText().toString().equals("null")) {
            errorFeedback += "\n- Valor do produto é invalido;";
            isValid = false;
        }

        return isValid;

    }

    public void editTakeCameraPhoto(View v) {

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

    public void editTakeGalleryPhoto(View v) {

        Intent i = new Intent(Intent.ACTION_PICK,android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
        startActivityForResult(i, 20);

    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent intent) {

        if (resultCode == RESULT_OK && intent != null) {

            // Camera photo:
            if (requestCode == 10) {

                File imgFile = new File(imagesFolder, lastPhotoName);

                if (imgFile.exists()) {

                    newPhotoPath = imgFile.getAbsolutePath();
                    Picasso.with(EditActivity.this).load("file://" + newPhotoPath).into(photo);

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
                    Toast.makeText(EditActivity.this, "Erro ao carregar esta imagem, por favor tente outra.", Toast.LENGTH_SHORT).show();
                } else {
                    newPhotoPath = picturePath;
                    Picasso.with(EditActivity.this).load("file://" + newPhotoPath).into(photo);
                }

            }

        }

    }

}
