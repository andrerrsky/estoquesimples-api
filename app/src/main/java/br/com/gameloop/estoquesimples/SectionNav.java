package br.com.gameloop.estoquesimples;

import android.content.Intent;
import android.view.MenuItem;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.bottomnavigation.BottomNavigationView;

/**
 * Navegação entre as seções principais (Início, Histórico, Relatórios,
 * Imp/Exp) a partir da barra inferior, em qualquer uma delas.
 *
 * Modelo: a Início é a raiz. Cada seção é uma Activity aberta a partir dela;
 * trocar de seção pela barra abre a nova e encerra a atual, então "voltar"
 * de qualquer seção sempre leva à Início — e nunca acumula pilha de telas
 * ao alternar entre abas. "Novo" é uma ação (abre o cadastro por cima da
 * seção atual), não um destino, por isso nunca fica marcado.
 */
public final class SectionNav {

    private SectionNav() {
    }

    public static void attach(AppCompatActivity activity, int selectedItemId) {
        BottomNavigationView nav = activity.findViewById(R.id.bottomNavigation);
        if (nav == null) {
            return;
        }
        nav.setOnItemSelectedListener(null);
        nav.setSelectedItemId(selectedItemId);
        nav.setOnItemSelectedListener(item -> onItemSelected(activity, item, selectedItemId));
    }

    private static boolean onItemSelected(AppCompatActivity activity, MenuItem item, int currentId) {
        int id = item.getItemId();
        if (id == currentId) {
            return true;
        }
        if (id == R.id.navigation_new) {
            activity.startActivity(new Intent(activity, AddActivity.class));
            // Continua marcando a seção atual: "Novo" não é um destino.
            return false;
        }
        Intent intent;
        if (id == R.id.navigation_home) {
            intent = new Intent(activity, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        } else if (id == R.id.navigation_history) {
            intent = new Intent(activity, HistoryActivity.class);
        } else if (id == R.id.navigation_reports) {
            intent = new Intent(activity, ReportsActivity.class);
        } else if (id == R.id.navigation_import) {
            intent = new Intent(activity, ImportActivity.class);
        } else {
            return false;
        }
        activity.startActivity(intent);
        activity.finish();
        // Troca de aba não é "entrar numa tela": sem animação de deslize.
        activity.overridePendingTransition(0, 0);
        return true;
    }
}
