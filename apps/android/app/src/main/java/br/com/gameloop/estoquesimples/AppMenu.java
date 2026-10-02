package br.com.gameloop.estoquesimples;

import android.app.Activity;
import android.content.Intent;
import android.view.MenuItem;

/**
 * Tratamento único dos itens do menu ⋮ que existem em mais de uma tela.
 * Cada Activity só cuida do que é dela (ex.: "Edição em Massa" na Início)
 * e delega o resto para cá.
 */
public final class AppMenu {

    private AppMenu() {
    }

    public static boolean handle(Activity activity, MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.menu_analytics) {
            activity.startActivity(new Intent(activity, AnalyticsActivity.class));
            return true;
        } else if (id == R.id.menu_account) {
            activity.startActivity(new Intent(activity, AccountActivity.class));
            return true;
        } else if (id == R.id.menu_subscription) {
            SubscriptionActivity.open(activity, "menu");
            return true;
        } else if (id == R.id.menu_settings) {
            activity.startActivity(new Intent(activity, SettingsActivity.class));
            return true;
        } else if (id == R.id.menu_support) {
            // "Ajuda e suporte" começa pelas perguntas frequentes; falar com
            // o suporte fica a um toque, no fim daquela tela.
            HelpActivity.open(activity);
            return true;
        } else if (id == R.id.menu_about) {
            activity.startActivity(new Intent(activity, AboutActivity.class));
            return true;
        }
        return false;
    }
}
