package br.com.gameloop.estoquesimples;

import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Html;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.data.CsvCodec;
import br.com.gameloop.estoquesimples.data.DataExchange;
import br.com.gameloop.estoquesimples.data.LocalBackup;
import br.com.gameloop.estoquesimples.data.LocalDb;
import br.com.gameloop.estoquesimples.data.OutboxRepository;
import br.com.gameloop.estoquesimples.sync.ApiException;
import br.com.gameloop.estoquesimples.sync.ExportClient;
import br.com.gameloop.estoquesimples.sync.SessionManager;

public class ImportActivity extends BaseActivity {

    private static final String TAG = "ImportActivity";
    private static final String LOG_PREFIX = "Log:\n\n";
    private static final int MAX_JSON_BYTES = 16 * 1024 * 1024;

    private TextView status;
    private TextView importDesc2;
    private TextView importExportDesc;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private ActivityResultLauncher<Intent> importFileLauncher;
    private ActivityResultLauncher<Intent> importDBLauncher;
    private ActivityResultLauncher<Intent> exportDBLauncher;
    private ActivityResultLauncher<Intent> exportCSVLauncher;
    private ActivityResultLauncher<Intent> exportMovementsCsvLauncher;
    private ActivityResultLauncher<Intent> exportJsonLauncher;
    private ActivityResultLauncher<Intent> exportCloudLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_import);

        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle("Importar e exportar");
        }
        SectionNav.attach(this, R.id.navigation_import);

        status = findViewById(R.id.importStatus);
        importDesc2 = findViewById(R.id.importDesc2);
        importExportDesc = findViewById(R.id.importExportDesc);

        if (status == null || importDesc2 == null || importExportDesc == null) {
            Toast.makeText(this, "Erro ao carregar interface. Por favor, reinicie o aplicativo.",
                    Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        CharSequence formato = Html.fromHtml(
                "Para abrir no Excel ou Google Planilhas, ou trazer produtos de uma planilha. "
                        + "Um produto que já existe (mesmo SKU, código de barras ou nome) é atualizado, não duplicado.<br>"
                        + "<b>Colunas:</b> nome, descrição, quantidade, valor, categoria, SKU, código de "
                        + "barras, fornecedor, localização, estoque mínimo, unidade.",
                Html.FROM_HTML_MODE_LEGACY);
        importDesc2.setText(formato);

        refreshRestoreButton();

        View advancedHeader = findViewById(R.id.advancedHeader);
        View advancedContent = findViewById(R.id.advancedContent);
        android.widget.ImageView advancedChevron = findViewById(R.id.advancedChevron);
        if (advancedHeader != null && advancedContent != null) {
            advancedHeader.setOnClickListener(v -> {
                boolean open = advancedContent.getVisibility() != View.VISIBLE;
                advancedContent.setVisibility(open ? View.VISIBLE : View.GONE);
                if (advancedChevron != null) {
                    advancedChevron.setImageResource(open ? R.drawable.ic_expand_less : R.drawable.ic_expand_more);
                    advancedChevron.setContentDescription(open ? "Ocultar opções avançadas" : "Mostrar opções avançadas");
                }
            });
        }

        initializeActivityResultLaunchers();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void initializeActivityResultLaunchers() {
        importFileLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        handlePortableImport(result.getData().getData());
                    }
                });

        importDBLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        handleDBImport(result.getData().getData());
                    }
                });

        exportDBLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        handleDBExport(result.getData().getData());
                    }
                });

        exportCSVLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        runExport(result.getData().getData(), ExchangeKind.PRODUCTS_CSV);
                    }
                });

        exportMovementsCsvLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        runExport(result.getData().getData(), ExchangeKind.MOVEMENTS_CSV);
                    }
                });

        exportJsonLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        runExport(result.getData().getData(), ExchangeKind.JSON);
                    }
                });

        exportCloudLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null
                            && result.getData().getData() != null) {
                        handleCloudExport(result.getData().getData());
                    }
                });
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.section_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return AppMenu.handle(this, item) || super.onOptionsItemSelected(item);
    }

    public void importFile(View v) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/plain", "text/csv", "text/comma-separated-values",
                "application/json", "application/octet-stream"
        });
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            importFileLauncher.launch(intent);
        } catch (android.content.ActivityNotFoundException ex) {
            Toast.makeText(this, "Por favor, instale um aplicativo gerenciador de arquivos.",
                    Toast.LENGTH_SHORT).show();
        }
    }

    public void importDBFile(View v) {
        int pendentes = pendingOutboxCount();
        if (pendentes > 0) {
            showPendingSyncDialog(pendentes);
            return;
        }

        new AlertDialog.Builder(this)
                .setTitle("Substituir todo o estoque?")
                .setMessage("Todos os produtos e o histórico deste aparelho serão trocados pelos do "
                        + "arquivo escolhido. Uma cópia automática do estado atual é gravada antes.")
                .setIcon(android.R.drawable.ic_dialog_alert)
                .setPositiveButton("Substituir tudo", (DialogInterface dialog, int whichButton) -> {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.setType("*/*");
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    try {
                        importDBLauncher.launch(intent);
                    } catch (android.content.ActivityNotFoundException ex) {
                        Toast.makeText(ImportActivity.this,
                                "Por favor, instale um aplicativo gerenciador de arquivos.",
                                Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    public void exportDBFile(View view) {
        launchCreateDocument("application/x-sqlite3", "EstoqueSimples_" + stamp() + ".db",
                exportDBLauncher);
    }

    public void exportCSVFile(View view) {
        launchCreateDocument("text/csv", "EstoqueSimples_produtos_" + stamp() + ".csv",
                exportCSVLauncher);
    }

    public void exportMovementsCsvFile(View view) {
        launchCreateDocument("text/csv", "EstoqueSimples_movimentacoes_" + stamp() + ".csv",
                exportMovementsCsvLauncher);
    }

    public void exportJsonFile(View view) {
        launchCreateDocument("application/json", "EstoqueSimples_" + stamp() + ".json",
                exportJsonLauncher);
    }

    public void exportCloudJson(View view) {
        SessionManager session = SessionManager.get(this);
        if (!session.isSignedIn() || session.workspaceId() == null) {
            Toast.makeText(this, "Entre na sua conta para baixar a cópia da nuvem.",
                    Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, AccountActivity.class));
            return;
        }
        launchCreateDocument("application/json",
                "EstoqueSimples_nuvem_" + stamp() + ".json", exportCloudLauncher);
    }

    /**
     * Sem cópia automática o botão não faz nada: fica desabilitado e diz
     * isso, em vez de responder com um aviso ao toque.
     */
    private void refreshRestoreButton() {
        android.widget.Button restore = findViewById(R.id.buttonRestoreBackup);
        if (restore == null) {
            return;
        }
        File[] copias = LocalBackup.list(this);
        boolean tem = copias != null && copias.length > 0;
        restore.setEnabled(tem);
        restore.setText(tem
                ? "Restaurar cópia automática (" + LocalBackup.describe(copias[0]) + ")"
                : "Restaurar cópia automática (nenhuma ainda)");
    }

    public void restoreAutomaticBackup(View view) {
        int pendentes = pendingOutboxCount();
        if (pendentes > 0) {
            showPendingSyncDialog(pendentes);
            return;
        }

        File[] copias = LocalBackup.list(this);
        if (copias.length == 0) {
            Toast.makeText(this, "Nenhuma cópia automática encontrada.", Toast.LENGTH_LONG).show();
            return;
        }

        String[] labels = new String[copias.length];
        for (int i = 0; i < copias.length; i++) {
            labels[i] = LocalBackup.describe(copias[i]);
        }

        new AlertDialog.Builder(this)
                .setTitle("Restaurar cópia automática")
                .setItems(labels, (dialog, which) -> confirmRestore(copias[which]))
                .setNegativeButton("Cancelar", null)
                .show();
    }

    private void confirmRestore(File copia) {
        new AlertDialog.Builder(this)
                .setTitle("Restaurar esta cópia?")
                .setMessage("O estoque atual será substituído por:\n" + LocalBackup.describe(copia)
                        + "\n\nUma cópia do estado de agora é gravada antes.")
                .setPositiveButton("Restaurar", (d, w) -> runRestore(copia))
                .setNegativeButton("Cancelar", null)
                .show();
    }

    private void runRestore(File copia) {
        executor.execute(() -> {
            boolean ok;
            synchronized (MainActivity.DB_LOCK) {
                ok = LocalBackup.restore(this, copia);
            }
            main.post(() -> {
                if (!ok) {
                    setImportExportDescText("Não foi possível restaurar a cópia.");
                    Toast.makeText(this, "Falha ao restaurar a cópia.", Toast.LENGTH_LONG).show();
                    return;
                }
                reopenAfterSwap();
                setImportExportDescText("Cópia restaurada. Os produtos já estão na lista.");
                Toast.makeText(this, "Cópia restaurada.", Toast.LENGTH_LONG).show();
            });
        });
    }

    private void handlePortableImport(Uri uri) {
        Toast.makeText(this, "Importando...", Toast.LENGTH_SHORT).show();
        executor.execute(() -> {
            DataExchange.Report report;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) {
                    main.post(() -> Toast.makeText(this, "Erro ao abrir arquivo", Toast.LENGTH_SHORT).show());
                    return;
                }
                byte[] bytes = readCapped(in, MAX_JSON_BYTES);
                String text = CsvCodec.stripBom(new String(bytes, StandardCharsets.UTF_8)).trim();
                if (!ensureDatabaseAvailable()) {
                    main.post(() -> Toast.makeText(this, "Banco de dados indisponível",
                            Toast.LENGTH_LONG).show());
                    return;
                }
                synchronized (MainActivity.DB_LOCK) {
                    DataExchange exchange = new DataExchange(MainActivity.stock);
                    if (text.startsWith("{")) {
                        report = exchange.importJson(new JSONObject(text));
                    } else {
                        report = exchange.importCsv(
                                new InputStreamReader(new java.io.ByteArrayInputStream(bytes),
                                        StandardCharsets.UTF_8));
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Erro ao importar arquivo", e);
                main.post(() -> {
                    if (status != null) {
                        status.setText(LOG_PREFIX + "Erro ao importar: " + e.getMessage());
                    }
                    Toast.makeText(this, "Erro ao importar arquivo.", Toast.LENGTH_SHORT).show();
                });
                return;
            }

            DataExchange.Report done = report;
            main.post(() -> {
                if (MainActivity.instance != null) {
                    MainActivity.instance.markListDirty(true);
                    MainActivity.instance.prepareList();
                }
                if (status != null) {
                    status.setText(LOG_PREFIX + done.asLog());
                }
                Toast.makeText(this, "Importação concluída.", Toast.LENGTH_SHORT).show();
            });
        });
    }

    private void handleDBImport(Uri uri) {
        executor.execute(() -> {
            boolean ok;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) {
                    main.post(() -> {
                        setImportExportDescText("Erro ao abrir arquivo de banco de dados");
                        Toast.makeText(this, "Erro ao abrir arquivo de banco de dados",
                                Toast.LENGTH_SHORT).show();
                    });
                    return;
                }
                synchronized (MainActivity.DB_LOCK) {
                    ok = LocalBackup.importFrom(this, in);
                }
            } catch (Exception e) {
                Log.e(TAG, "Erro ao importar banco de dados", e);
                main.post(() -> {
                    setImportExportDescText("Erro ao importar: " + e.getMessage());
                    Toast.makeText(this, "Ocorreu um erro ao importar o banco de dados.",
                            Toast.LENGTH_SHORT).show();
                });
                return;
            }

            boolean sucesso = ok;
            main.post(() -> {
                if (!sucesso) {
                    setImportExportDescText("O arquivo não é um banco SQLite válido.");
                    Toast.makeText(this, "Arquivo inválido.", Toast.LENGTH_LONG).show();
                    return;
                }
                reopenAfterSwap();
                setImportExportDescText("Banco de dados importado com sucesso!\n\nOs produtos já estão disponíveis na lista.");
                Toast.makeText(this, "Banco de dados importado com sucesso!", Toast.LENGTH_SHORT).show();
            });
        });
    }

    private void handleDBExport(Uri uri) {
        executor.execute(() -> {
            if (!ensureDatabaseAvailable()) {
                main.post(() -> Toast.makeText(this, "Banco de dados não disponível",
                        Toast.LENGTH_LONG).show());
                return;
            }
            boolean ok;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    main.post(() -> Toast.makeText(this, "Erro ao criar arquivo de exportação",
                            Toast.LENGTH_SHORT).show());
                    return;
                }
                synchronized (MainActivity.DB_LOCK) {
                    ok = LocalBackup.exportTo(MainActivity.stock, out);
                }
            } catch (Exception e) {
                Log.e(TAG, "Erro ao exportar banco de dados", e);
                main.post(() -> {
                    setImportExportDescText("Erro ao exportar: " + e.getMessage());
                    Toast.makeText(this, "Ocorreu um erro ao exportar o banco de dados.",
                            Toast.LENGTH_SHORT).show();
                });
                return;
            }
            boolean sucesso = ok;
            main.post(() -> {
                if (!sucesso) {
                    setImportExportDescText("Erro ao exportar o banco de dados.");
                    return;
                }
                setImportExportDescText("Banco de dados exportado com sucesso!\n\nO arquivo foi salvo no local escolhido.");
                Toast.makeText(this, "Banco de dados exportado com sucesso!", Toast.LENGTH_SHORT).show();
            });
        });
    }

    private void runExport(Uri uri, ExchangeKind kind) {
        executor.execute(() -> {
            if (!ensureDatabaseAvailable()) {
                main.post(() -> Toast.makeText(this, "Banco de dados não disponível",
                        Toast.LENGTH_LONG).show());
                return;
            }
            DataExchange.Report report;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    main.post(() -> Toast.makeText(this, "Erro ao criar arquivo de exportação",
                            Toast.LENGTH_SHORT).show());
                    return;
                }
                synchronized (MainActivity.DB_LOCK) {
                    DataExchange exchange = new DataExchange(MainActivity.stock);
                    if (kind == ExchangeKind.PRODUCTS_CSV) {
                        report = exchange.exportProductsCsv(out);
                    } else if (kind == ExchangeKind.MOVEMENTS_CSV) {
                        report = exchange.exportMovementsCsv(out);
                    } else {
                        report = exchange.exportJson(out);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Erro ao exportar", e);
                main.post(() -> {
                    setImportExportDescText("Erro ao exportar: " + e.getMessage());
                    Toast.makeText(this, "Ocorreu um erro ao exportar os dados.", Toast.LENGTH_SHORT).show();
                });
                return;
            }
            DataExchange.Report done = report;
            main.post(() -> {
                String oQue = kind == ExchangeKind.MOVEMENTS_CSV
                        ? "movimentação(ões)"
                        : "produto(s)";
                setImportExportDescText("Exportação concluída.\n\n"
                        + done.exported + " " + oQue + " gravado(s) no arquivo escolhido.");
                Toast.makeText(this, done.exported + " registro(s) exportado(s).",
                        Toast.LENGTH_LONG).show();
            });
        });
    }

    private void handleCloudExport(Uri uri) {
        executor.execute(() -> {
            try {
                JSONObject json = new ExportClient(this).downloadJson();
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        throw new IllegalStateException("destino indisponível");
                    }
                    out.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
                int produtos = json.optJSONArray("products") == null
                        ? 0 : json.optJSONArray("products").length();
                main.post(() -> {
                    setImportExportDescText("Cópia da nuvem salva.\n\n"
                            + produtos + " produto(s) no arquivo. Isso não alterou o estoque deste aparelho.");
                    Toast.makeText(this, "Cópia da nuvem salva.", Toast.LENGTH_LONG).show();
                });
            } catch (ApiException e) {
                Log.w(TAG, "falha ao baixar cópia da nuvem", e);
                main.post(() -> Toast.makeText(this, e.userMessage(), Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.e(TAG, "Erro ao gravar cópia da nuvem", e);
                main.post(() -> Toast.makeText(this, "Erro ao gravar o arquivo.", Toast.LENGTH_SHORT).show());
            }
        });
    }

    private void launchCreateDocument(String mime, String title, ActivityResultLauncher<Intent> launcher) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, title);
        try {
            launcher.launch(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Erro ao iniciar exportação: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            Log.e(TAG, "Erro ao iniciar exportação", e);
        }
    }

    private void showPendingSyncDialog(int pendentes) {
        new AlertDialog.Builder(this)
                .setTitle("Sincronize antes de substituir")
                .setMessage(pendentes + (pendentes == 1
                        ? " alteração ainda não foi enviada para a nuvem."
                        : " alterações ainda não foram enviadas para a nuvem.")
                        + " Substituir o banco agora faria você perdê-la"
                        + (pendentes == 1 ? "" : "s") + " definitivamente.\n\n"
                        + "Sincronize primeiro pela tela de conta e tente de novo.")
                .setPositiveButton("Entendi", null)
                .show();
    }

    private int pendingOutboxCount() {
        if (!ensureDatabaseAvailable()) {
            return 0;
        }
        synchronized (MainActivity.DB_LOCK) {
            return new OutboxRepository(MainActivity.stock).pendingCount();
        }
    }

    private void reopenAfterSwap() {
        if (MainActivity.instance != null) {
            MainActivity.instance.openOrCreateDB();
            MainActivity.instance.prepareList();
            MainActivity.instance.markListDirty(true);
        }
    }

    /**
     * Resultado das operações avançadas (.db, cópia automática). Antes ia
     * para a descrição do card, que agora é o subtítulo do "Avançado"
     * recolhido — a mensagem ficaria escondida. Vai para a área de status
     * da tela e para uma confirmação no rodapé.
     */
    private void setImportExportDescText(String text) {
        if (status != null) {
            status.setText(text);
        }
        if (text != null) {
            Feedback.show(this, text.split("\n")[0]);
        }
    }

    private boolean ensureDatabaseAvailable() {
        try {
            if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                return true;
            }
            if (MainActivity.instance != null) {
                MainActivity.instance.openOrCreateDB();
                if (MainActivity.stock != null && MainActivity.stock.isOpen()) {
                    return true;
                }
            }
            MainActivity.stock = LocalDb.open(this);
            return MainActivity.stock != null && MainActivity.stock.isOpen();
        } catch (Exception e) {
            Log.e(TAG, "Error ensuring database availability", e);
            return false;
        }
    }

    private static byte[] readCapped(InputStream in, int maxBytes) throws java.io.IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        int total = 0;
        while ((read = in.read(chunk)) != -1) {
            total += read;
            if (total > maxBytes) {
                throw new java.io.IOException("Arquivo grande demais para importar.");
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private static String stamp() {
        return new SimpleDateFormat("dd-M-yyyy_HH-mm-ss", Locale.getDefault()).format(new Date());
    }

    private enum ExchangeKind {
        PRODUCTS_CSV,
        MOVEMENTS_CSV,
        JSON
    }
}
