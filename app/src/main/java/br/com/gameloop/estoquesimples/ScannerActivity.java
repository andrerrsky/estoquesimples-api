package br.com.gameloop.estoquesimples;

import android.os.Bundle;
import android.view.View;
import android.widget.Button;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.journeyapps.barcodescanner.CaptureActivity;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;

/**
 * Tela do leitor de código de barras. A CaptureActivity padrão da biblioteca
 * não conhece edge-to-edge: a instrução ("Escaneie o código…") ficava atrás
 * da barra de navegação do sistema, e não havia botão para fechar nem para
 * a lanterna — num depósito escuro, ler código sem lanterna não funciona.
 */
public class ScannerActivity extends CaptureActivity {

    private boolean torchOn;

    @Override
    protected DecoratedBarcodeView initializeContent() {
        setContentView(R.layout.activity_scanner);
        DecoratedBarcodeView scanner = findViewById(R.id.zxing_barcode_scanner);
        View root = findViewById(R.id.scannerRoot);
        View topBar = findViewById(R.id.scannerTopBar);
        View statusView = scanner.getStatusView();
        float density = getResources().getDisplayMetrics().density;

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            topBar.setPadding(topBar.getPaddingLeft(), bars.top, topBar.getPaddingRight(), 0);
            int extra = Math.round(16 * density);
            statusView.setPadding(extra, extra, extra, bars.bottom + extra);
            return insets;
        });
        ViewCompat.requestApplyInsets(root);

        findViewById(R.id.scannerClose).setOnClickListener(v -> finish());

        Button torch = findViewById(R.id.scannerTorch);
        if (!getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_FLASH)) {
            torch.setVisibility(View.GONE);
        }
        torch.setOnClickListener(v -> {
            torchOn = !torchOn;
            if (torchOn) {
                scanner.setTorchOn();
            } else {
                scanner.setTorchOff();
            }
            torch.setText(torchOn ? "Apagar lanterna" : "Lanterna");
        });
        return scanner;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
}
