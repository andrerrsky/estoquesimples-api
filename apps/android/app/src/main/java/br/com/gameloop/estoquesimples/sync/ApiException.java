package br.com.gameloop.estoquesimples.sync;

/**
 * Falha ao conversar com a API.
 *
 * O ponto importante é a distinção entre {@link #isTransient()} e o resto. Uma
 * falha transitória (rede caiu, servidor fora do ar) precisa ser tentada de
 * novo; uma permanente (dado inválido, acesso removido) não vai melhorar com
 * repetição e precisa aparecer para o usuário. Tratar as duas do mesmo jeito
 * gera ou uma fila que nunca anda, ou dados descartados sem aviso.
 */
public class ApiException extends Exception {

    /** Códigos estáveis devolvidos pela API, espelhando o catálogo do servidor. */
    public static final String SEM_REDE = "SEM_REDE";
    public static final String NAO_AUTENTICADO = "UNAUTHENTICATED";
    public static final String PERMISSAO_DESATUALIZADA = "AUTH_PERMISSION_STALE";
    public static final String SEM_PERMISSAO = "FORBIDDEN";
    public static final String EMAIL_NAO_CONFIRMADO = "AUTH_EMAIL_NOT_VERIFIED";
    public static final String ASSINATURA_INATIVA = "SUBSCRIPTION_INACTIVE";
    /** Código atual da API; o anterior fica como alias por aparelhos antigos. */
    public static final String ASSINATURA_OBRIGATORIA = "SUBSCRIPTION_REQUIRED";
    /** Teto do plano (produtos na nuvem, pessoas na empresa) atingido. */
    public static final String LIMITE_PLANO = "PLAN_LIMIT_REACHED";
    /**
     * O ponto de leitura deste aparelho não vale mais e a nuvem precisa ser
     * relida do zero. O texto tem de ser exatamente o que o servidor manda: a
     * constante já esteve escrita como "RESYNC_REQUIRED" e, por não bater com
     * nada, ninguém nunca a comparava com sucesso — o aparelho recebia a
     * instrução de recarregar, não a reconhecia e ficava parado.
     */
    public static final String RESSINCRONIZAR = "SYNC_RESYNC_REQUIRED";
    /** A gravação local do que veio da nuvem falhou; a leitura para por aqui. */
    public static final String FALHA_LOCAL = "FALHA_LOCAL";
    /** O sistema pediu a vaga de volta no meio do trabalho. */
    public static final String INTERROMPIDO = "INTERROMPIDO";
    public static final String PROTOCOLO_INCOMPATIVEL = "SYNC_PROTOCOL_UNSUPPORTED";
    public static final String CONFLITO = "CONFLICT";
    public static final String TOKEN_EM_USO = "PURCHASE_TOKEN_IN_USE";
    public static final String TOKEN_INVALIDO = "PURCHASE_TOKEN_INVALID";
    public static final String BILLING_INDISPONIVEL = "BILLING_UNAVAILABLE";

    private final int statusCode;
    private final String code;
    private final Long retryAfterSeconds;

    public ApiException(int statusCode, String code, String message, Long retryAfterSeconds) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public static ApiException network(Throwable cause) {
        ApiException e = new ApiException(0, SEM_REDE,
                "Sem conexão com o servidor.", null);
        e.initCause(cause);
        return e;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public String getCode() {
        return code;
    }

    public Long getRetryAfterSeconds() {
        return retryAfterSeconds;
    }

    /**
     * Vale a pena tentar de novo mais tarde.
     *
     * Erros de rede, indisponibilidade e excesso de requisições passam. Uma
     * gravação local que falhou e uma parada pedida pelo sistema também: em
     * nenhum dos dois casos há algo errado com o dado, só com o momento.
     *
     * <p>A ressincronização fica de fora de propósito. Ela não é uma falha nem
     * uma espera: é uma instrução para recarregar do zero, e quem a recebe tem
     * de agir. Tratá-la como transitória adiaria a fila inteira com backoff
     * exponencial sem que ninguém recarregasse coisa alguma.
     */
    public boolean isTransient() {
        if (SEM_REDE.equals(code) || FALHA_LOCAL.equals(code) || INTERROMPIDO.equals(code)) {
            return true;
        }
        return statusCode == 408 || statusCode == 429 || statusCode >= 500;
    }

    /** Assinatura ou teto do plano impedem a ação; o app oferece o plano Equipe. */
    public boolean isPlanBlocked() {
        return ASSINATURA_OBRIGATORIA.equals(code) || ASSINATURA_INATIVA.equals(code)
                || LIMITE_PLANO.equals(code);
    }

    /** Teto do plano atingido (produtos ou pessoas). */
    public boolean isPlanLimit() {
        return LIMITE_PLANO.equals(code);
    }

    /** O servidor mandou recarregar a nuvem inteira. */
    public boolean needsResync() {
        return RESSINCRONIZAR.equals(code);
    }

    /**
     * O papel do usuário mudou e o token em uso descreve permissões antigas.
     *
     * Chega como 401, mas não é sessão expirada: basta trocar o token de
     * acesso. Tratar como logout faria alguém ser expulso do app só porque um
     * administrador ajustou o papel dele.
     */
    public boolean isPermissionStale() {
        return PERMISSAO_DESATUALIZADA.equals(code);
    }

    /** O acesso precisa ser renovado antes de qualquer nova tentativa. */
    public boolean needsReauth() {
        return statusCode == 401 && !isPermissionStale();
    }

    /**
     * A conta existe, mas o e-mail ainda não foi confirmado.
     *
     * Convidar alguém dispara e-mail em nome da empresa; o servidor recusa
     * isso até a confirmação. Não é falta de papel de proprietário.
     */
    public boolean isEmailUnverified() {
        return EMAIL_NAO_CONFIRMADO.equals(code);
    }

    /** Mensagem pronta para exibição, sem jargão de protocolo. */
    public String userMessage() {
        if (SEM_REDE.equals(code)) {
            return "Sem conexão. Suas alterações estão salvas no aparelho e serão "
                    + "enviadas quando a internet voltar.";
        }
        if (TOKEN_EM_USO.equals(code)) {
            return "Esta assinatura já está vinculada a outra empresa. Use a conta Google "
                    + "que assinou para esta empresa, ou entre em contato com o suporte.";
        }
        if (TOKEN_INVALIDO.equals(code)) {
            return "O Google não reconheceu este comprovante de compra. "
                    + "Tente restaurar a compra ou assinar de novo.";
        }
        if (BILLING_INDISPONIVEL.equals(code)) {
            return "A validação da assinatura está temporariamente indisponível. "
                    + "Vamos tentar de novo automaticamente.";
        }
        if (isPermissionStale()) {
            return "Seu papel na empresa mudou. Estamos atualizando seu acesso.";
        }
        if (EMAIL_NAO_CONFIRMADO.equals(code)) {
            String message = getMessage();
            return message != null && !message.isEmpty()
                    ? message
                    : "Confirme seu e-mail antes de convidar outras pessoas.";
        }
        if ("AUTH_TOKEN_INVALID".equals(code)) {
            String message = getMessage();
            return message != null && !message.isEmpty()
                    ? message
                    : "Código inválido ou expirado.";
        }
        if (statusCode == 401) {
            return "Sua sessão expirou. Entre novamente para continuar sincronizando.";
        }
        if (statusCode == 403) {
            if (ASSINATURA_INATIVA.equals(code) || ASSINATURA_OBRIGATORIA.equals(code)
                    || LIMITE_PLANO.equals(code)) {
                // O servidor explica o que falta (equipe, teto de produtos);
                // a mensagem dele é mais precisa do que qualquer texto fixo.
                String message = getMessage();
                return message != null && !message.isEmpty()
                        ? message
                        : "Este recurso faz parte do plano Equipe. Os dados continuam no aparelho.";
            }
            if (isEmailUnverified()) {
                String message = getMessage();
                return message != null && !message.isEmpty()
                        ? message
                        : "Confirme seu e-mail antes de convidar outras pessoas.";
            }
            return "Você não tem permissão para esta ação. Peça ao proprietário da empresa.";
        }
        if (statusCode == 426) {
            return "Esta versão do app é antiga demais para sincronizar. Atualize pela Play Store.";
        }
        if (statusCode >= 500) {
            return "O servidor está indisponível no momento. Vamos tentar de novo automaticamente.";
        }
        String message = getMessage();
        return message != null ? message : "Não foi possível sincronizar agora.";
    }
}
