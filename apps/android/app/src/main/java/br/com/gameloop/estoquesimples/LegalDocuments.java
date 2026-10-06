package br.com.gameloop.estoquesimples;

import br.com.gameloop.estoquesimples.branding.BrandStore;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.method.LinkMovementMethod;
import android.text.style.ClickableSpan;
import android.view.View;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

/**
 * Atalhos para os documentos legais do cadastro.
 *
 * O texto deixa claro que criar a conta implica concordância. Os documentos
 * completos ficam numa tela própria, acessível depois do login também.
 */
final class LegalDocuments {

    static final String PAGE_TERMOS = "termos";
    static final String PAGE_PRIVACIDADE = "privacidade";

    private LegalDocuments() {}

    static void open(Context context, String page) {
        Intent intent = new Intent(context, LegalActivity.class);
        intent.putExtra(LegalActivity.EXTRA_PAGE, page);
        context.startActivity(intent);
    }

    static void bindCadastroNotice(TextView view) {
        bind(view, "Ao criar a conta, você declara ter lido e concordado com os "
                + "Termos de Uso e a Política de Privacidade.");
    }

    static void bindInviteNotice(TextView view) {
        bind(view, "Ao continuar, você concorda com os Termos de Uso e a "
                + "Política de Privacidade.");
    }

    /** Rodapé simples com os dois links, sem frase de consentimento em volta. */
    static void bindFooterLinks(TextView view) {
        bind(view, "Termos de Uso  ·  Política de Privacidade");
    }

    private static void bind(TextView view, String texto) {
        SpannableString span = new SpannableString(texto);
        int brand = BrandStore.color(view.getContext(), R.color.color_accent);
        marcar(span, texto, "Termos de Uso", PAGE_TERMOS, brand);
        marcar(span, texto, "Política de Privacidade", PAGE_PRIVACIDADE, brand);
        view.setText(span);
        view.setMovementMethod(LinkMovementMethod.getInstance());
        view.setHighlightColor(Color.TRANSPARENT);
        view.setLinksClickable(true);
    }

    private static void marcar(SpannableString span, String texto, String trecho, String page, int brand) {
        int inicio = texto.indexOf(trecho);
        if (inicio < 0) {
            return;
        }
        int fim = inicio + trecho.length();
        span.setSpan(new ClickableSpan() {
            @Override
            public void onClick(View widget) {
                open(widget.getContext(), page);
            }

            @Override
            public void updateDrawState(TextPaint ds) {
                ds.setColor(brand);
                ds.setUnderlineText(true);
            }
        }, inicio, fim, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
}
