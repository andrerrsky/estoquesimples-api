package br.com.gameloop.estoquesimples.blog;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import br.com.gameloop.estoquesimples.BaseActivity;
import br.com.gameloop.estoquesimples.ConnectivityPrompt;
import br.com.gameloop.estoquesimples.R;
import br.com.gameloop.estoquesimples.analytics.Analytics;
import br.com.gameloop.estoquesimples.sync.ApiException;

/** Lista de posts do blog (dicas, avisos e novidades), com filtro por categoria. */
public class BlogActivity extends BaseActivity {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final BlogClient client = new BlogClient();
    private final List<BlogClient.Post> posts = new ArrayList<>();

    private ListView listView;
    private ProgressBar progress;
    private TextView emptyView;
    private LinearLayout chipRow;
    private View footerMore;
    private String category = "";
    private int page = 1;
    private boolean hasMore;
    private boolean loading;
    private Adapter adapter;

    public static void open(Context context) {
        context.startActivity(new Intent(context, BlogActivity.class));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_blog);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setTitle("Dicas e novidades");
        }
        listView = findViewById(R.id.blogList);
        progress = findViewById(R.id.blogProgress);
        emptyView = findViewById(R.id.blogEmpty);
        chipRow = findViewById(R.id.blogChipRow);

        footerMore = LayoutInflater.from(this).inflate(R.layout.item_blog_more, listView, false);
        footerMore.findViewById(R.id.blogMoreButton).setOnClickListener(v -> load(page + 1));
        listView.addFooterView(footerMore, null, false);
        adapter = new Adapter();
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> {
            if (position < posts.size()) {
                BlogPostActivity.open(this, posts.get(position).slug);
            }
        });

        addChip("Todos", "", true);
        loadCategories();
        load(1);
    }

    private void addChip(String label, String slug, boolean selected) {
        TextView chip = (TextView) LayoutInflater.from(this).inflate(R.layout.item_help_chip, chipRow, false);
        chip.setText(label);
        chip.setTag(slug);
        chip.setSelected(selected);
        chip.setOnClickListener(v -> {
            category = slug;
            for (int i = 0; i < chipRow.getChildCount(); i++) {
                View child = chipRow.getChildAt(i);
                child.setSelected(slug.equals(child.getTag()));
            }
            load(1);
        });
        chipRow.addView(chip);
    }

    private void loadCategories() {
        executor.execute(() -> {
            try {
                List<JSONObject> categories = client.categories();
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    for (JSONObject item : categories) {
                        addChip(item.optString("label"), item.optString("slug"), false);
                    }
                });
            } catch (Exception ignored) {
                // sem categorias a lista continua inteira
            }
        });
    }

    private void load(int requestedPage) {
        if (loading) return;
        loading = true;
        if (requestedPage == 1) {
            progress.setVisibility(View.VISIBLE);
            emptyView.setVisibility(View.GONE);
        }
        footerMore.setVisibility(View.GONE);
        executor.execute(() -> {
            try {
                BlogClient.Page result = client.list(category, requestedPage);
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    loading = false;
                    progress.setVisibility(View.GONE);
                    if (requestedPage == 1) posts.clear();
                    posts.addAll(result.items);
                    page = result.page;
                    hasMore = result.hasMore();
                    footerMore.setVisibility(hasMore ? View.VISIBLE : View.GONE);
                    emptyView.setVisibility(posts.isEmpty() ? View.VISIBLE : View.GONE);
                    emptyView.setText("Nenhum post por aqui ainda.");
                    adapter.notifyDataSetChanged();
                });
            } catch (ApiException e) {
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    loading = false;
                    progress.setVisibility(View.GONE);
                    if (posts.isEmpty()) {
                        emptyView.setVisibility(View.VISIBLE);
                        emptyView.setText("Não foi possível carregar o blog. Confira a internet e tente de novo.");
                    }
                    ConnectivityPrompt.report(this, e, () -> load(requestedPage));
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    loading = false;
                    progress.setVisibility(View.GONE);
                });
            }
        });
    }

    static String formatDate(String iso) {
        if (iso == null || iso.isEmpty()) return "";
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            parser.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date date = parser.parse(iso.substring(0, 19));
            return new SimpleDateFormat("d 'de' MMMM 'de' yyyy", new Locale("pt", "BR")).format(date);
        } catch (Exception e) {
            return "";
        }
    }

    private final class Adapter extends BaseAdapter {
        @Override
        public int getCount() {
            return posts.size();
        }

        @Override
        public Object getItem(int position) {
            return posts.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            View view = convertView != null ? convertView
                    : LayoutInflater.from(BlogActivity.this).inflate(R.layout.item_blog_post, parent, false);
            BlogClient.Post post = posts.get(position);
            ((TextView) view.findViewById(R.id.postCategory)).setText(post.membersOnly ? post.categoryLabel + "  ·  🔒 Exclusivo" : post.categoryLabel);
            ((TextView) view.findViewById(R.id.postTitle)).setText(post.title);
            ((TextView) view.findViewById(R.id.postExcerpt)).setText(post.excerpt);
            ((TextView) view.findViewById(R.id.postMeta)).setText(formatDate(post.publishedAt)
                    + " · " + post.readingMinutes + " min de leitura");
            return view;
        }
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

    @Override
    protected void onResume() {
        super.onResume();
        Analytics.track(this, "blog.opened");
    }
}
