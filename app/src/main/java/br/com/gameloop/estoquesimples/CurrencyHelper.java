package br.com.gameloop.estoquesimples;

import android.content.Context;
import android.content.SharedPreferences;

import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.text.NumberFormat;
import java.util.Locale;

/**
 * Centralized utility for monetary value formatting, parsing, and currency
 * preference management. Uses a cached ThreadLocal NumberFormat to avoid
 * repeated DecimalFormat creation (which causes GC pressure and ANRs).
 */
public final class CurrencyHelper {

    private static final String PREFS_NAME = "EstoqueSimplesPrefs";
    private static final String KEY_CURRENCY_SYMBOL = "currency_symbol";
    private static final String DEFAULT_CURRENCY = "$";

    public static final String[] AVAILABLE_CURRENCIES = {"$", "R$", "€", "£", "¥"};

    private static volatile String cachedSymbol = null;
    private static volatile Locale cachedLocale = null;
    private static final ThreadLocal<DecimalFormat> FORMATTER = new ThreadLocal<>();
    private static volatile long formatVersion = 0;
    private static final ThreadLocal<Long> threadFormatVersion = new ThreadLocal<Long>() {
        @Override
        protected Long initialValue() {
            return -1L;
        }
    };

    private CurrencyHelper() {}

    /**
     * Pre-warm the formatter on the current thread to reduce first-use
     * latency and GC pressure during ad callbacks.
     */
    public static void warmUp(Context context) {
        getCurrencySymbol(context);
        getFormatter();
    }

    public static String getCurrencySymbol(Context context) {
        if (cachedSymbol == null) {
            SharedPreferences prefs = context.getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            cachedSymbol = prefs.getString(KEY_CURRENCY_SYMBOL, DEFAULT_CURRENCY);
            cachedLocale = localeForSymbol(cachedSymbol);
        }
        return cachedSymbol;
    }

    public static void setCurrencySymbol(Context context, String symbol) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_CURRENCY_SYMBOL, symbol).apply();
        cachedSymbol = symbol;
        cachedLocale = localeForSymbol(symbol);
        formatVersion++;
    }

    public static Locale getLocale(Context context) {
        getCurrencySymbol(context);
        return cachedLocale;
    }

    /**
     * Formats a double value as a currency string with thousands separators.
     * Example (pt-BR): "R$ 42.592,88" / (en-US): "$42,592.88"
     */
    public static String formatCurrency(Context context, double value) {
        String symbol = getCurrencySymbol(context);
        DecimalFormat fmt = getFormatter();
        return symbol + " " + fmt.format(value);
    }

    /**
     * Formats a double value with thousands separators but without currency symbol.
     */
    public static String formatNumber(double value) {
        return getFormatter().format(value);
    }

    /**
     * Robustly parses a monetary string into a double, handling all legacy
     * formats stored in the database: raw numbers, comma decimals, currency
     * prefixes ($, R$, €, £, ¥), and mixed formats.
     */
    public static double parseCurrency(String input, double defaultVal) {
        if (input == null || input.isEmpty() || input.equalsIgnoreCase("null")) {
            return defaultVal;
        }
        try {
            String cleaned = input.trim();
            // Strip known currency symbols and whitespace
            cleaned = cleaned.replace("R$", "")
                    .replace("$", "")
                    .replace("€", "")
                    .replace("£", "")
                    .replace("¥", "")
                    .replace("\u00A0", "") // non-breaking space
                    .trim();

            if (cleaned.isEmpty()) {
                return defaultVal;
            }

            // Determine which character is the decimal separator.
            // Heuristic: if both ',' and '.' are present, the last one is the decimal sep.
            int lastComma = cleaned.lastIndexOf(',');
            int lastDot = cleaned.lastIndexOf('.');

            if (lastComma > lastDot) {
                // Comma is decimal separator (e.g., "1.234,56" or "1234,56")
                cleaned = cleaned.replace(".", "").replace(",", ".");
            } else if (lastDot > lastComma) {
                // Dot is decimal separator (e.g., "1,234.56" or "1234.56")
                cleaned = cleaned.replace(",", "");
            } else {
                // Only one or none present — if comma exists, treat as decimal
                if (lastComma >= 0) {
                    cleaned = cleaned.replace(",", ".");
                }
            }

            return Double.parseDouble(cleaned);
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }

    /**
     * Strips all currency symbols and normalizes a raw input string to a
     * clean numeric string suitable for database storage ("1234.56").
     */
    public static String sanitizeForStorage(String input) {
        double val = parseCurrency(input, 0.0);
        if (val == 0.0 && input != null && !input.trim().isEmpty()) {
            String trimmed = input.trim()
                    .replace("R$", "").replace("$", "")
                    .replace("€", "").replace("£", "").replace("¥", "")
                    .replace(",", ".").trim();
            if (!trimmed.isEmpty()) {
                return trimmed;
            }
        }
        // Store with dot as decimal separator, no thousands separator
        DecimalFormat storageFmt = new DecimalFormat("0.##");
        storageFmt.setDecimalFormatSymbols(DecimalFormatSymbols.getInstance(Locale.US));
        return storageFmt.format(val);
    }

    private static DecimalFormat getFormatter() {
        long currentVersion = formatVersion;
        Long tVersion = threadFormatVersion.get();
        DecimalFormat fmt = FORMATTER.get();
        if (fmt == null || tVersion == null || tVersion != currentVersion) {
            Locale locale = cachedLocale != null ? cachedLocale : Locale.US;
            DecimalFormatSymbols symbols = DecimalFormatSymbols.getInstance(locale);
            fmt = new DecimalFormat("#,##0.00", symbols);
            FORMATTER.set(fmt);
            threadFormatVersion.set(currentVersion);
        }
        return fmt;
    }

    private static Locale localeForSymbol(String symbol) {
        if (symbol == null) return Locale.US;
        switch (symbol) {
            case "R$":
                return new Locale("pt", "BR");
            case "€":
                return Locale.GERMANY;
            case "£":
                return Locale.UK;
            case "¥":
                return Locale.JAPAN;
            case "$":
            default:
                return Locale.US;
        }
    }
}
