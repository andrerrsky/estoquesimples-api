package br.com.gameloop.estoquesimples.data;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * CSV no formato que planilhas realmente geram.
 *
 * O export antigo trocava vírgula por espaço e o import fazia {@code split(",")},
 * então qualquer descrição com vírgula nascia mutilada e qualquer campo entre
 * aspas virava vários produtos. Aqui o texto entre aspas pode conter o
 * separador, aspas são duplicadas, e células que o Excel interpretaria como
 * fórmula ganham um apóstrofo na frente na hora de escrever.
 */
public final class CsvCodec {

    private CsvCodec() {
    }

    public static final char VIRGULA = ',';
    public static final char PONTO_E_VIRGULA = ';';

    /** Marca de ordem de bytes UTF-8, para o Excel abrir acentos corretamente. */
    public static final String BOM_UTF8 = "\uFEFF";

    /**
     * Lê o arquivo inteiro, inclusive campos com quebra de linha entre aspas.
     */
    public static List<List<String>> parse(Reader reader) throws IOException {
        BufferedReader buffered = reader instanceof BufferedReader
                ? (BufferedReader) reader
                : new BufferedReader(reader);

        String primeira = buffered.readLine();
        if (primeira == null) {
            return Collections.emptyList();
        }
        primeira = stripBom(primeira);
        char delimiter = detectDelimiter(primeira);

        List<List<String>> rows = new ArrayList<>();
        StringBuilder pending = new StringBuilder(primeira);
        while (true) {
            List<String> parsed = parseLine(pending.toString(), delimiter);
            if (isCompleteRecord(pending.toString(), delimiter)) {
                if (!isBlankRow(parsed)) {
                    rows.add(parsed);
                }
                pending.setLength(0);
                String next = buffered.readLine();
                if (next == null) {
                    break;
                }
                pending.append(next);
            } else {
                String next = buffered.readLine();
                if (next == null) {
                    if (pending.length() > 0 && !isBlankRow(parsed)) {
                        rows.add(parsed);
                    }
                    break;
                }
                pending.append('\n').append(next);
            }
        }
        return rows;
    }

    /**
     * Quebra uma linha já isolada. Usada pelos testes e pelo caso em que o
     * chamador já leu linha a linha de um arquivo sem quebras dentro de campo.
     */
    public static List<String> parseLine(String line, char delimiter) {
        List<String> fields = new ArrayList<>();
        if (line == null) {
            return fields;
        }
        StringBuilder current = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                        current.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current.append(c);
                }
            } else if (c == '"') {
                inQuotes = true;
            } else if (c == delimiter) {
                fields.add(current.toString().trim());
                current.setLength(0);
            } else {
                current.append(c);
            }
        }
        fields.add(current.toString().trim());
        return fields;
    }

    public static String escape(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String sanitized = neutralizeFormula(value.replace("\r\n", "\n"));
        boolean precisaAspas = sanitized.indexOf(',') >= 0
                || sanitized.indexOf(';') >= 0
                || sanitized.indexOf('"') >= 0
                || sanitized.indexOf('\n') >= 0
                || sanitized.indexOf('\r') >= 0
                || startsAsFormula(sanitized);
        if (!precisaAspas) {
            return sanitized;
        }
        return "\"" + sanitized.replace("\"", "\"\"") + "\"";
    }

    public static String join(List<String> fields) {
        StringBuilder line = new StringBuilder();
        for (int i = 0; i < fields.size(); i++) {
            if (i > 0) {
                line.append(',');
            }
            line.append(escape(fields.get(i)));
        }
        return line.toString();
    }

    public static char detectDelimiter(String headerLine) {
        if (headerLine == null || headerLine.isEmpty()) {
            return VIRGULA;
        }
        int virgulas = countUnquoted(headerLine, VIRGULA);
        int pontos = countUnquoted(headerLine, PONTO_E_VIRGULA);
        return pontos > virgulas ? PONTO_E_VIRGULA : VIRGULA;
    }

    public static boolean looksLikeHeader(List<String> fields) {
        if (fields == null || fields.isEmpty()) {
            return false;
        }
        String first = normalizeHeader(fields.get(0));
        return "nome".equals(first)
                || "name".equals(first)
                || "produto".equals(first)
                || "id".equals(first)
                || "sku".equals(first);
    }

    public static String normalizeHeader(String raw) {
        if (raw == null) {
            return "";
        }
        String trimmed = stripBom(raw).trim().toLowerCase(Locale.ROOT);
        StringBuilder out = new StringBuilder(trimmed.length());
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (c == ' ' || c == '-' || c == '.') {
                out.append('_');
            } else {
                out.append(semAcento(c));
            }
        }
        return out.toString();
    }

    public static String stripBom(String text) {
        if (text != null && !text.isEmpty() && text.charAt(0) == '\uFEFF') {
            return text.substring(1);
        }
        return text;
    }

    /**
     * Impede que o Excel execute fórmula a partir de um campo do estoque
     * (CSV injection). O apóstrofo é a convenção que o próprio Excel entende
     * como "isto é texto".
     */
    public static String neutralizeFormula(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        if (startsAsFormula(value) && !pareceNumero(value)) {
            return "'" + value;
        }
        return value;
    }

    static boolean startsAsFormula(String value) {
        char first = value.charAt(0);
        return first == '=' || first == '+' || first == '-' || first == '@'
                || first == '\t' || first == '\r';
    }

    static boolean pareceNumero(String value) {
        if (value.isEmpty()) {
            return false;
        }
        try {
            Double.parseDouble(value.replace(',', '.'));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static boolean isCompleteRecord(String line, char delimiter) {
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '"') {
                if (inQuotes && i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            }
        }
        return !inQuotes;
    }

    private static boolean isBlankRow(List<String> fields) {
        if (fields == null || fields.isEmpty()) {
            return true;
        }
        for (String field : fields) {
            if (field != null && !field.trim().isEmpty()) {
                return false;
            }
        }
        return true;
    }

    private static int countUnquoted(String line, char delimiter) {
        int count = 0;
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '"') {
                inQuotes = !inQuotes;
            } else if (!inQuotes && c == delimiter) {
                count++;
            }
        }
        return count;
    }

    private static char semAcento(char c) {
        switch (c) {
            case 'á':
            case 'à':
            case 'â':
            case 'ã':
                return 'a';
            case 'é':
            case 'ê':
                return 'e';
            case 'í':
                return 'i';
            case 'ó':
            case 'ô':
            case 'õ':
                return 'o';
            case 'ú':
                return 'u';
            case 'ç':
                return 'c';
            default:
                return c;
        }
    }
}
