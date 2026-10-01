package br.com.gameloop.estoquesimples.data;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;

/**
 * Cópia do banco antes de operações que mudam muita coisa de uma vez.
 *
 * A primeira sincronização é o momento de maior risco de toda a mudança: o
 * banco do usuário passa a conversar com um servidor pela primeira vez. Se algo
 * der errado, precisa existir um arquivo intacto de antes. A cópia é feita sem
 * exceção, mesmo que o diagnóstico não aponte nada.
 */
public final class LocalBackup {

    private static final String TAG = "LocalBackup";

    private static final String PASTA = "backups";
    /** Quantas cópias manter. Além disso, é só ocupar espaço do usuário. */
    private static final int MANTER = 5;

    private LocalBackup() {
    }

    /**
     * Copia o arquivo do banco para a pasta privada do app.
     *
     * O WAL é integrado antes da cópia. Sem isso, o arquivo copiado pode não
     * conter as últimas transações — elas ainda estariam no diário à parte, que
     * não seria copiado junto, e o backup nasceria desatualizado.
     */
    public static File create(Context context, SQLiteDatabase db, String motivo) {
        try {
            // execSQL, e não rawQuery: o cursor do Android é preguiçoso e só
            // executa a consulta quando alguém lê. Com rawQuery().close(), o
            // pragma nunca chegava a rodar e a cópia nascia sem as últimas
            // transações — que continuavam só no diário, fora do arquivo.
            db.execSQL("PRAGMA wal_checkpoint(FULL)");
        } catch (Exception e) {
            Log.w(TAG, "não foi possível consolidar o diário antes da cópia", e);
        }

        File origem = new File(db.getPath());
        File pasta = new File(context.getFilesDir(), PASTA);
        if (!pasta.exists() && !pasta.mkdirs()) {
            Log.e(TAG, "não foi possível criar a pasta de cópias");
            return null;
        }

        String carimbo = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        File destino = new File(pasta, "estoque-" + carimbo + "-" + motivo + ".db");

        try (FileChannel entrada = new FileInputStream(origem).getChannel();
             FileChannel saida = new FileOutputStream(destino).getChannel()) {
            saida.transferFrom(entrada, 0, entrada.size());
            Log.i(TAG, "cópia criada em " + destino.getName());
            prune(pasta);
            return destino;
        } catch (IOException e) {
            Log.e(TAG, "falha ao copiar o banco", e);
            // Um destino pela metade é pior que nenhum: seria restaurado como
            // se estivesse íntegro.
            if (destino.exists() && !destino.delete()) {
                Log.w(TAG, "cópia incompleta não pôde ser removida");
            }
            return null;
        }
    }

    /** Cópias existentes, da mais recente para a mais antiga. */
    public static File[] list(Context context) {
        File pasta = new File(context.getFilesDir(), PASTA);
        File[] arquivos = pasta.listFiles((dir, name) -> name.endsWith(".db"));
        if (arquivos == null) {
            return new File[0];
        }
        Arrays.sort(arquivos, Comparator.comparingLong(File::lastModified).reversed());
        return arquivos;
    }

    /**
     * Volta o banco para o conteúdo de uma cópia.
     *
     * Uma cópia que ninguém consegue restaurar não é uma cópia, é um arquivo
     * ocupando espaço. Este é o caminho de volta que faltava para as cópias
     * criadas antes da carga inicial e antes de uma recarga completa.
     *
     * <p>Antes de sobrescrever, o estado atual é copiado de novo, com o motivo
     * "antes-de-restaurar". Restaurar a cópia errada é um engano fácil de
     * cometer e, sem isso, seria tão irreversível quanto o problema que a
     * restauração veio consertar.
     *
     * <p>A conexão é fechada e os arquivos {@code -wal} e {@code -shm} são
     * apagados junto: eles descrevem transações do banco que está sendo
     * substituído e, aplicados sobre o arquivo novo, o corromperiam. O app
     * precisa ser reiniciado depois — nenhuma tela pode continuar usando a
     * conexão antiga.
     *
     * @return {@code true} se o arquivo foi substituído.
     */
    public static boolean restore(Context context, File copia) {
        if (copia == null || !copia.isFile() || copia.length() == 0L) {
            Log.e(TAG, "cópia inexistente ou vazia");
            return false;
        }
        if (!isOwnedCopy(context, copia)) {
            Log.e(TAG, "cópia fora da pasta de backups ou inválida");
            return false;
        }

        File destino = context.getDatabasePath(LocalDb.DATABASE_NAME);

        try {
            LocalBackup.create(context, LocalDb.open(context), "antes-de-restaurar");
        } catch (Exception e) {
            Log.w(TAG, "não foi possível guardar o estado atual antes de restaurar", e);
        }

        LocalDb.closeForFileSwap();

        try (FileChannel entrada = new FileInputStream(copia).getChannel();
             FileChannel saida = new FileOutputStream(destino).getChannel()) {
            saida.transferFrom(entrada, 0, entrada.size());
        } catch (IOException e) {
            Log.e(TAG, "falha ao restaurar a cópia", e);
            return false;
        }

        deleteQuietly(new File(destino.getPath() + "-wal"));
        deleteQuietly(new File(destino.getPath() + "-shm"));

        Log.i(TAG, "cópia restaurada de " + copia.getName());
        return true;
    }

    /**
     * Confirma que o arquivo está dentro da pasta privada de cópias.
     *
     * Restaurar a partir de um caminho arbitrário permitiria que um arquivo
     * escolhido em outro lugar (ou um nome com {@code ..}) substituísse o
     * banco. A lista da tela só oferece o que {@link #list} devolve, mas a
     * checagem fica aqui para não depender de quem chama.
     */
    public static boolean isOwnedCopy(Context context, File copia) {
        if (copia == null) {
            return false;
        }
        try {
            File pasta = new File(context.getFilesDir(), PASTA).getCanonicalFile();
            File alvo = copia.getCanonicalFile();
            String prefixo = pasta.getPath() + "/";
            return alvo.getPath().startsWith(prefixo) && alvo.isFile() && alvo.getName().endsWith(".db");
        } catch (IOException e) {
            Log.w(TAG, "não foi possível validar o caminho da cópia", e);
            return false;
        }
    }

    /**
     * Consolida o WAL e copia o banco para o destino escolhido pelo usuário.
     */
    public static boolean exportTo(SQLiteDatabase db, OutputStream destino) {
        try {
            db.execSQL("PRAGMA wal_checkpoint(FULL)");
        } catch (Exception e) {
            Log.w(TAG, "não foi possível consolidar o diário antes da exportação", e);
        }

        File origem = new File(db.getPath());
        try (FileInputStream entrada = new FileInputStream(origem)) {
            copy(entrada, destino);
            destino.flush();
            return true;
        } catch (IOException e) {
            Log.e(TAG, "falha ao exportar o banco", e);
            return false;
        }
    }

    /**
     * Substitui o banco local pelo conteúdo do fluxo.
     *
     * Recusa arquivo que não começa com o cabeçalho SQLite, copia o estado
     * atual para a pasta de backups e apaga {@code -wal}/{@code -shm} para o
     * diário antigo não se aplicar sobre o arquivo novo.
     *
     * @return {@code true} se o arquivo foi substituído. Quem chama precisa
     *         reabrir a conexão ({@code MainActivity.openOrCreateDB}).
     */
    public static boolean importFrom(Context context, InputStream origem) {
        File temp = new File(context.getCacheDir(), "estoque-import.tmp");
        try {
            try (FileOutputStream saida = new FileOutputStream(temp)) {
                copy(origem, saida);
            }
            if (!isSqliteFile(temp)) {
                Log.e(TAG, "arquivo não é um banco SQLite");
                return false;
            }

            try {
                LocalBackup.create(context, LocalDb.open(context), "antes-de-restaurar");
            } catch (Exception e) {
                Log.w(TAG, "não foi possível guardar o estado atual antes de importar", e);
            }

            LocalDb.closeForFileSwap();

            File destino = context.getDatabasePath(LocalDb.DATABASE_NAME);
            try (FileChannel entrada = new FileInputStream(temp).getChannel();
                 FileChannel saida = new FileOutputStream(destino).getChannel()) {
                saida.transferFrom(entrada, 0, entrada.size());
            }

            deleteQuietly(new File(destino.getPath() + "-wal"));
            deleteQuietly(new File(destino.getPath() + "-shm"));
            Log.i(TAG, "banco substituído a partir de arquivo externo");
            return true;
        } catch (IOException e) {
            Log.e(TAG, "falha ao importar o banco", e);
            return false;
        } finally {
            deleteQuietly(temp);
        }
    }

    private static boolean isSqliteFile(File arquivo) throws IOException {
        if (arquivo == null || arquivo.length() < 16L) {
            return false;
        }
        byte[] header = new byte[16];
        try (FileInputStream in = new FileInputStream(arquivo)) {
            if (in.read(header) < 16) {
                return false;
            }
        }
        return new String(header, StandardCharsets.US_ASCII)
                .startsWith("SQLite format 3");
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }

    /** Rótulo legível de uma cópia, para a lista de restauração. */
    public static String describe(File copia) {
        String data = new SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault())
                .format(new Date(copia.lastModified()));
        long kb = Math.max(1L, copia.length() / 1024L);
        String motivo = motivoFromName(copia.getName());
        return data + (motivo.isEmpty() ? "" : " · " + motivo) + " · " + kb + " KB";
    }

    private static String motivoFromName(String name) {
        if (name == null || !name.endsWith(".db")) {
            return "";
        }
        String stem = name.substring(0, name.length() - 3);
        int lastDash = stem.lastIndexOf('-');
        if (lastDash < 0 || lastDash == stem.length() - 1) {
            return "";
        }
        switch (stem.substring(lastDash + 1)) {
            case "carga-inicial":
                return "antes da 1ª sincronização";
            case "recarga-completa":
                return "antes da recarga";
            case "antes-de-restaurar":
                return "antes de restaurar";
            default:
                return "";
        }
    }

    private static void deleteQuietly(File arquivo) {
        if (arquivo.exists() && !arquivo.delete()) {
            Log.w(TAG, "não foi possível remover " + arquivo.getName());
        }
    }

    private static void prune(File pasta) {
        File[] arquivos = pasta.listFiles((dir, name) -> name.endsWith(".db"));
        if (arquivos == null || arquivos.length <= MANTER) {
            return;
        }
        Arrays.sort(arquivos, Comparator.comparingLong(File::lastModified).reversed());
        for (int i = MANTER; i < arquivos.length; i++) {
            if (!arquivos[i].delete()) {
                Log.w(TAG, "cópia antiga não pôde ser removida: " + arquivos[i].getName());
            }
        }
    }
}
