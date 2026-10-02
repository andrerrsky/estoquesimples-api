package br.com.gameloop.estoquesimples.help;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.LeadingMarginSpan;
import android.text.style.StyleSpan;
import android.util.DisplayMetrics;
import android.util.TypedValue;

import java.util.List;

/**
 * Resposta de um artigo pronta para um TextView: negrito, itens de lista
 * com recuo e respiro entre os blocos.
 */
public final class HelpSpans {

    // O respiro entre blocos é uma linha vazia de fonte pequena: a altura
    // final é a da fonte mais o lineSpacingExtra do TextView.
    private static final float RESPIRO_PARAGRAFO_DP = 7f;
    private static final float RESPIRO_ITEM_DP = 2f;
    // Em sp: o recuo e a bolinha crescem junto com a letra de quem aumentou
    // a fonte nas configurações de acessibilidade.
    private static final float RECUO_MARCADOR_SP = 18f;
    private static final float RAIO_MARCADOR_SP = 2.5f;

    private HelpSpans() {
    }

    public static CharSequence render(Context context, List<String> answer) {
        DisplayMetrics metricas = context.getResources().getDisplayMetrics();
        int respiroParagrafo = Math.round(RESPIRO_PARAGRAFO_DP * metricas.density);
        int respiroItem = Math.round(RESPIRO_ITEM_DP * metricas.density);
        int recuo = Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, RECUO_MARCADOR_SP, metricas));
        float raio = TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, RAIO_MARCADOR_SP, metricas);

        SpannableStringBuilder texto = new SpannableStringBuilder();
        boolean anteriorEraItem = false;
        for (HelpMarkup.Block bloco : HelpMarkup.parse(answer)) {
            if (texto.length() > 0) {
                // Fecha o bloco anterior e abre uma linha vazia baixinha.
                // Itens seguidos de uma mesma lista ficam mais juntos.
                texto.append('\n');
                int inicioRespiro = texto.length();
                texto.append('\n');
                texto.setSpan(
                        new AbsoluteSizeSpan(anteriorEraItem && bloco.bullet ? respiroItem : respiroParagrafo),
                        inicioRespiro, texto.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            int inicio = texto.length();
            texto.append(bloco.text);
            for (int i = 0; i + 1 < bloco.bold.length; i += 2) {
                texto.setSpan(new StyleSpan(Typeface.BOLD),
                        inicio + bloco.bold[i], inicio + bloco.bold[i + 1],
                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            if (bloco.bullet) {
                texto.setSpan(new Marcador(recuo, raio), inicio, texto.length(),
                        Spanned.SPAN_INCLUSIVE_EXCLUSIVE);
            }
            anteriorEraItem = bloco.bullet;
        }
        return texto;
    }

    /**
     * Item de lista: recuo em todas as linhas e a bolinha na primeira.
     * O BulletSpan do sistema só aceita raio a partir da API 28; abaixo
     * disso a bolinha tem tamanho fixo em pixels e some em telas densas.
     */
    private static final class Marcador implements LeadingMarginSpan {

        private final int recuo;
        private final float raio;

        Marcador(int recuo, float raio) {
            this.recuo = recuo;
            this.raio = raio;
        }

        @Override
        public int getLeadingMargin(boolean first) {
            return recuo;
        }

        @Override
        public void drawLeadingMargin(Canvas canvas, Paint paint, int x, int dir, int top,
                                      int baseline, int bottom, CharSequence text, int start,
                                      int end, boolean first, Layout layout) {
            if (!(text instanceof Spanned) || ((Spanned) text).getSpanStart(this) != start) {
                return;
            }
            Paint.Style estilo = paint.getStyle();
            paint.setStyle(Paint.Style.FILL);
            // Centro na altura do meio das letras da primeira linha, não da
            // caixa da linha (que inclui o espaçamento extra entre linhas).
            float centroY = baseline + (paint.ascent() + paint.descent()) / 2f;
            float centroX = x + dir * (raio + raio);
            canvas.drawCircle(centroX, centroY, raio, paint);
            paint.setStyle(estilo);
        }
    }
}
