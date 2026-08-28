package br.com.gameloop.estoquesimples.sync;

import android.widget.TextView;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Replica no aparelho a política de {@code password.ts} da API.
 *
 * Validar aqui evita a ida à rede só para ouvir "senha fraca", e o checklist
 * da tela de cadastro usa exatamente os mesmos critérios do servidor.
 */
public final class PasswordPolicy {

    public static final int MIN_LENGTH = 10;
    public static final int MAX_LENGTH = 200;

    private static final Set<String> COMMON = Set.of(
            "12345678",
            "123456789",
            "1234567890",
            "senha123",
            "password",
            "password1",
            "qwertyui",
            "estoque123",
            "admin123",
            "abcd1234");

    private PasswordPolicy() {}

    public static final class Result {
        public final boolean lengthOk;
        public final boolean notCommon;
        public final boolean notRepeated;
        public final boolean notContainsEmail;
        public final List<String> problems;

        Result(boolean lengthOk, boolean notCommon, boolean notRepeated,
               boolean notContainsEmail, List<String> problems) {
            this.lengthOk = lengthOk;
            this.notCommon = notCommon;
            this.notRepeated = notRepeated;
            this.notContainsEmail = notContainsEmail;
            this.problems = Collections.unmodifiableList(problems);
        }

        public boolean isValid() {
            return problems.isEmpty();
        }
    }

    public static Result check(String password, String email) {
        String senha = password == null ? "" : password;
        List<String> problems = new ArrayList<>();

        boolean lengthOk = senha.length() >= MIN_LENGTH && senha.length() <= MAX_LENGTH;
        if (senha.length() < MIN_LENGTH) {
            problems.add("A senha deve ter pelo menos " + MIN_LENGTH + " caracteres.");
        } else if (senha.length() > MAX_LENGTH) {
            problems.add("A senha deve ter no máximo " + MAX_LENGTH + " caracteres.");
        }

        boolean notCommon = !COMMON.contains(senha.toLowerCase(Locale.ROOT));
        if (!notCommon) {
            problems.add("Esta senha é muito comum. Escolha outra.");
        }

        boolean notRepeated = senha.isEmpty() || !senha.matches("^(.)\\1+$");
        if (!senha.isEmpty() && !notRepeated) {
            problems.add("A senha não pode ser um único caractere repetido.");
        }

        boolean notContainsEmail = true;
        if (email != null) {
            String local = email.split("@", 2)[0].toLowerCase(Locale.ROOT);
            if (local.length() >= 4 && senha.toLowerCase(Locale.ROOT).contains(local)) {
                notContainsEmail = false;
                problems.add("A senha não pode conter o seu e-mail.");
            }
        }

        return new Result(lengthOk, notCommon, notRepeated, notContainsEmail, problems);
    }

    /**
     * Pinta o checklist: cinza em repouso, verde quando a regra passa, vermelho
     * só depois que a pessoa começou a digitar.
     */
    public static void render(TextView length, TextView common, TextView repeated,
                              TextView emailRule, Result result, boolean started) {
        paint(length, result.lengthOk, started, "Pelo menos " + MIN_LENGTH + " caracteres");
        paint(common, result.notCommon, started, "Diferente de senhas óbvias");
        paint(repeated, result.notRepeated, started, "Não é o mesmo caractere repetido");
        paint(emailRule, result.notContainsEmail, started, "Não contém o seu e-mail");
    }

    private static void paint(TextView view, boolean ok, boolean started, String label) {
        if (!started) {
            view.setText("○  " + label);
            view.setTextColor(ContextCompat.getColor(view.getContext(),
                    br.com.gameloop.estoquesimples.R.color.color_text_muted));
        } else if (ok) {
            view.setText("✓  " + label);
            view.setTextColor(ContextCompat.getColor(view.getContext(),
                    br.com.gameloop.estoquesimples.R.color.color_success));
        } else {
            view.setText("✗  " + label);
            view.setTextColor(ContextCompat.getColor(view.getContext(),
                    br.com.gameloop.estoquesimples.R.color.color_error));
        }
    }
}
