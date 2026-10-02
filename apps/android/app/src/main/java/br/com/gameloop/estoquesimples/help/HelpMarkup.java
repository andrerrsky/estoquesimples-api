package br.com.gameloop.estoquesimples.help;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Formato do texto das respostas, de propósito mínimo para render igual na
 * web, no painel e aqui: cada item de {@code answer} é um bloco; começando
 * com "• ", é um item de lista; {@code **assim**} é negrito.
 *
 * Aqui só se separa o texto das marcações. Transformar isso em spans do
 * Android fica em {@link HelpSpans} — o que deixa esta parte testável na JVM.
 */
public final class HelpMarkup {

    private static final String MARCADOR = "• ";

    // Igual ao da web: dois asteriscos, um trecho sem asterisco, dois
    // asteriscos. Asterisco sem par fica como texto comum.
    private static final Pattern NEGRITO = Pattern.compile("\\*\\*([^*]+)\\*\\*");

    private HelpMarkup() {
    }

    public static final class Block {
        /** Item de lista (o "• " já foi retirado de {@link #text}). */
        public final boolean bullet;
        /** Texto como aparece na tela, sem os asteriscos. */
        public final String text;
        /** Trechos em negrito: pares início/fim (fim exclusivo) dentro de {@link #text}. */
        public final int[] bold;

        Block(boolean bullet, String text, int[] bold) {
            this.bullet = bullet;
            this.text = text;
            this.bold = bold;
        }
    }

    public static List<Block> parse(List<String> answer) {
        List<Block> blocos = new ArrayList<>();
        if (answer == null) {
            return blocos;
        }
        for (String linha : answer) {
            if (linha != null) {
                blocos.add(parse(linha));
            }
        }
        return blocos;
    }

    public static Block parse(String linha) {
        boolean marcador = linha.startsWith(MARCADOR);
        String origem = marcador ? linha.substring(MARCADOR.length()) : linha;

        StringBuilder texto = new StringBuilder(origem.length());
        List<Integer> trechos = new ArrayList<>();
        Matcher matcher = NEGRITO.matcher(origem);
        int cursor = 0;
        while (matcher.find()) {
            texto.append(origem, cursor, matcher.start());
            trechos.add(texto.length());
            texto.append(matcher.group(1));
            trechos.add(texto.length());
            cursor = matcher.end();
        }
        texto.append(origem, cursor, origem.length());

        int[] negrito = new int[trechos.size()];
        for (int i = 0; i < negrito.length; i++) {
            negrito[i] = trechos.get(i);
        }
        return new Block(marcador, texto.toString(), negrito);
    }
}
