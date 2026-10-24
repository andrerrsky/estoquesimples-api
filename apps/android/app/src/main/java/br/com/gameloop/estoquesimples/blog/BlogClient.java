package br.com.gameloop.estoquesimples.blog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import br.com.gameloop.estoquesimples.sync.ApiClient;
import br.com.gameloop.estoquesimples.sync.ApiException;

/** Leitura pública do blog (sem login): a mesma API que a web usa. */
public final class BlogClient {

    public static final class Post {
        public final String id;
        public final String slug;
        public final String title;
        public final String excerpt;
        public final String contentHtml;
        public final String categoryLabel;
        public final String categorySlug;
        public final String publishedAt;
        public final String authorName;
        public final int readingMinutes;
        public final String url;
        public final String coverUrl;

        Post(JSONObject json) {
            id = json.optString("id");
            slug = json.optString("slug");
            title = json.optString("title");
            excerpt = json.optString("excerpt");
            contentHtml = json.optString("contentHtml", "");
            JSONObject category = json.optJSONObject("category");
            categoryLabel = category != null ? category.optString("label") : "";
            categorySlug = category != null ? category.optString("slug") : "";
            publishedAt = json.isNull("publishedAt") ? null : json.optString("publishedAt", null);
            authorName = json.optString("authorName", "Equipe Estoque Simples");
            readingMinutes = json.optInt("readingMinutes", 1);
            url = json.optString("url");
            coverUrl = json.isNull("coverUrl") ? null : json.optString("coverUrl", null);
        }
    }

    public static final class Page {
        public final List<Post> items;
        public final int total;
        public final int page;
        public final int pageSize;

        Page(JSONObject json) {
            items = new ArrayList<>();
            JSONArray array = json.optJSONArray("items");
            for (int i = 0; array != null && i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) items.add(new Post(item));
            }
            total = json.optInt("total");
            page = json.optInt("page", 1);
            pageSize = json.optInt("pageSize", 20);
        }

        public boolean hasMore() {
            return page * pageSize < total;
        }
    }

    private final ApiClient api = new ApiClient();

    public Page list(String category, int page) throws ApiException {
        String path = "/v1/blog/posts?page=" + page + "&pageSize=20"
                + (category == null || category.isEmpty() ? "" : "&category=" + category);
        return new Page(api.get(path, null).body);
    }

    public Post get(String slug) throws ApiException {
        JSONObject body = api.get("/v1/blog/posts/" + slug, null).body;
        JSONObject post = body.optJSONObject("post");
        return new Post(post != null ? post : body);
    }

    public List<JSONObject> categories() throws ApiException {
        JSONObject body = api.get("/v1/blog/facets", null).body;
        List<JSONObject> out = new ArrayList<>();
        JSONArray array = body.optJSONArray("categories");
        for (int i = 0; array != null && i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item != null && item.optInt("count") > 0) out.add(item);
        }
        return out;
    }
}
