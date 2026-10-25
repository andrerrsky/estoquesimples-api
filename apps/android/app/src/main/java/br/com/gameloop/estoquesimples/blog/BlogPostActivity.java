package br.com.gameloop.estoquesimples.blog;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.method.LinkMovementMethod;
import android.view.MenuItem;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.BaseActivity;
import br.com.gameloop.estoquesimples.ConnectivityPrompt;
import br.com.gameloop.estoquesimples.R;
import br.com.gameloop.estoquesimples.AccountActivity;
import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.sync.SessionManager;
import br.com.gameloop.estoquesimples.sync.ApiException;

/** Um post do blog, lido da API e mostrado como texto formatado. */
public class BlogPostActivity extends BaseActivity {

    public static final String EXTRA_SLUG = "br.com.gameloop.estoquesimples.BLOG_SLUG";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private BlogClient.Post post;

    public static void open(Context context, String slug) {
        context.startActivity(new Intent(context, BlogPostActivity.class).putExtra(EXTRA_SLUG, slug));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_blog_post);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Blog");
        }
        findViewById(R.id.postShare).setOnClickListener(v -> share());
        findViewById(R.id.postOpenWeb).setOnClickListener(v -> {
            if (post != null) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(post.url)));
        });
        findViewById(R.id.postRetry).setOnClickListener(v -> load());
        findViewById(R.id.postLockedButton).setOnClickListener(v -> startActivity(new Intent(this, AccountActivity.class)));
        load();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Voltou da tela de conta já logado: o post exclusivo vem inteiro.
        if (post != null && post.locked && SessionManager.get(this).isSignedIn()) load();
    }

    private void load() {
        String slug = getIntent().getStringExtra(EXTRA_SLUG);
        if (slug == null || slug.isEmpty()) {
            finish();
            return;
        }
        ProgressBar progress = findViewById(R.id.postProgress);
        View error = findViewById(R.id.postError);
        View content = findViewById(R.id.postContent);
        progress.setVisibility(View.VISIBLE);
        error.setVisibility(View.GONE);
        content.setVisibility(View.GONE);
        executor.execute(() -> {
            try {
                String token = null;
                SessionManager session = SessionManager.get(this);
                if (session.isSignedIn()) {
                    try {
                        token = session.accessToken();
                    } catch (ApiException ignored) {
                        // sem token válido o post vem como para quem não tem conta
                    }
                }
                BlogClient.Post loaded = new BlogClient().get(slug, token);
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    post = loaded;
                    progress.setVisibility(View.GONE);
                    content.setVisibility(View.VISIBLE);
                    ((TextView) findViewById(R.id.postCategory)).setText(loaded.categoryLabel);
                    ((TextView) findViewById(R.id.postTitle)).setText(loaded.title);
                    ((TextView) findViewById(R.id.postExcerpt)).setText(loaded.excerpt);
                    ((TextView) findViewById(R.id.postMeta)).setText(loaded.authorName + " · "
                            + BlogActivity.formatDate(loaded.publishedAt) + " · " + loaded.readingMinutes + " min de leitura");
                    TextView body = findViewById(R.id.postBody);
                    body.setText(BlogHtml.render(loaded.contentHtml));
                    body.setMovementMethod(LinkMovementMethod.getInstance());
                    findViewById(R.id.postLocked).setVisibility(loaded.locked ? View.VISIBLE : View.GONE);
                    Analytics.track(this, "blog.post_viewed", Analytics.props("slug", loaded.slug, "category", loaded.categorySlug));
                });
            } catch (ApiException e) {
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    progress.setVisibility(View.GONE);
                    error.setVisibility(View.VISIBLE);
                    ((TextView) findViewById(R.id.postErrorText)).setText(e.getStatusCode() == 404
                            ? "Este post não está mais disponível."
                            : "Não foi possível carregar o post. Confira a internet e tente de novo.");
                    ConnectivityPrompt.report(this, e, this::load);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    progress.setVisibility(View.GONE);
                    error.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    private void share() {
        if (post == null) return;
        Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, post.title)
                .putExtra(Intent.EXTRA_TEXT, post.title + "\n" + post.url);
        startActivity(Intent.createChooser(intent, "Compartilhar post"));
        Analytics.track(this, "blog.post_shared", Analytics.props("slug", post.slug, "via", "share"));
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onDestroy() {
        executor.shutdown();
        super.onDestroy();
    }
}
