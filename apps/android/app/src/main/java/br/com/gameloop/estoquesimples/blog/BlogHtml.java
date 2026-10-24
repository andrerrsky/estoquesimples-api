package br.com.gameloop.estoquesimples.blog;

import android.text.Html;
import android.text.Spanned;

/**
 * O HTML do post (gerado e limpo pela API) no TextView do Android.
 * {@code Html.fromHtml} não entende listas nem títulos; aqui eles viram o
 * equivalente que ele entende, com a mesma leitura.
 */
public final class BlogHtml {

    private BlogHtml() {
    }

    public static Spanned render(String html) {
        String prepared = html
                .replaceAll("(?s)<h2[^>]*>(.*?)</h2>", "<p><big><b>$1</b></big></p>")
                .replaceAll("(?s)<h3[^>]*>(.*?)</h3>", "<p><b>$1</b></p>")
                .replaceAll("(?s)<blockquote>\\s*<p>(.*?)</p>\\s*</blockquote>", "<p><i>$1</i></p>")
                .replaceAll("(?s)<pre><code>(.*?)</code></pre>", "<p><tt>$1</tt></p>")
                .replaceAll("<code>", "<tt>").replaceAll("</code>", "</tt>")
                .replaceAll("(?s)<img[^>]*>", "")
                .replaceAll("<hr>", "<br>")
                .replaceAll("<ul>|<ol>", "<p>")
                .replaceAll("</ul>|</ol>", "</p>")
                .replaceAll("<li>", "&#8226;&nbsp; ")
                .replaceAll("</li>", "<br>");
        return Html.fromHtml(prepared, Html.FROM_HTML_MODE_LEGACY);
    }
}
