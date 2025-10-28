package br.com.gameloop.estoquesimples;

import android.database.Cursor;
import android.os.Bundle;
import android.support.v7.app.AppCompatActivity;
import android.text.Html;
import android.view.MenuItem;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

import lecho.lib.hellocharts.model.PieChartData;
import lecho.lib.hellocharts.model.SliceValue;
import lecho.lib.hellocharts.util.ChartUtils;
import lecho.lib.hellocharts.view.PieChartView;

public class ReportsActivity extends AppCompatActivity {

    private PieChartView chart;
    private PieChartData data;

    private String higherAmoutProductText;
    private String lowerAmoutProductText;
    private int higherAmoutProductValue;
    private int lowerAmoutProductValue;

    private TextView higher;
    private TextView lower;

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_reports);

        getSupportActionBar().setDisplayHomeAsUpEnabled(true);

        chart = (PieChartView) findViewById(R.id.chart);

        higher = (TextView) findViewById(R.id.higher);
        lower = (TextView) findViewById(R.id.lower);

        generateData();

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

    private void generateData() {

        List<SliceValue> values = new ArrayList<SliceValue>();

        Cursor cursor = MainActivity.stock.rawQuery("SELECT name, amount FROM Estoque", null);

        int cursorCount = cursor.getCount();

        if(cursor.moveToFirst()) {

            String columnName = cursor.getString(0);
            int columnAmount = parseWithDefault(cursor.getString(1), 0);

            SliceValue sliceValue = new SliceValue(columnAmount, ChartUtils.pickColor());
            sliceValue.setLabel(columnName + " (" + (int)sliceValue.getValue() + ")");
            values.add(sliceValue);

            higherAmoutProductText = "<b>Maior</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";
            lowerAmoutProductText = "<b>Menor</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";

            higherAmoutProductValue = columnAmount;
            lowerAmoutProductValue = columnAmount;

            while (cursor.moveToNext()) {

                columnName = cursor.getString(0);
                columnAmount = parseWithDefault(cursor.getString(1), 0);

                if(columnAmount > higherAmoutProductValue) {
                    higherAmoutProductValue = columnAmount;
                    higherAmoutProductText = "<b>Maior</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";
                }

                if(columnAmount < lowerAmoutProductValue) {
                    lowerAmoutProductValue = columnAmount;
                    lowerAmoutProductText = "<b>Menor</b> quantidade no estoque: <b>" + columnName + " (" + columnAmount + ")</b>";
                }

                sliceValue = new SliceValue(columnAmount, ChartUtils.pickColor());
                sliceValue.setLabel(columnName + " (" + (int)sliceValue.getValue() + ")");
                values.add(sliceValue);

            }

        }

        cursor.close();

        data = new PieChartData(values);
        data.setHasLabels(true);
        data.setHasLabelsOnlyForSelected(false);
        data.setHasLabelsOutside(false);
        data.setHasCenterCircle(false);

        chart.setPieChartData(data);
        chart.setInteractive(false);

        if(cursorCount > 0) {

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                higher.setText(Html.fromHtml(higherAmoutProductText, Html.FROM_HTML_MODE_LEGACY));
                lower.setText(Html.fromHtml(lowerAmoutProductText, Html.FROM_HTML_MODE_LEGACY));
            } else {
                higher.setText(Html.fromHtml(higherAmoutProductText));
                lower.setText(Html.fromHtml(lowerAmoutProductText));
            }

        } else {

            higher.setText("Sem informações no momento.");
            lower.setText("");

        }

    }

    public static int parseWithDefault(String number, int defaultVal) {
        try {
            return Integer.parseInt(number);
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }

}
