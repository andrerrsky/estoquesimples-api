package br.com.gameloop.estoquesimples.billing;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Regras puras (sem Android) da oferta promocional da Google Play.
 *
 * Tudo o que decide a oferta e o cartão da tela inicial mora aqui para ser
 * testado na JVM: qual oferta escolher pela tag, o texto montado a partir das
 * fases de preço, a janela de datas no horário de Brasília e quando o cartão
 * fechado volta. Valores nunca são fixos: preço e duração vêm das fases que a
 * Play devolve. Por política da Play, nenhum texto daqui fala de outro canal
 * de pagamento ou de outro preço.
 */
public final class PromoRules {

    /** Tag da oferta de Black Friday no base plan mensal (Play Console). */
    public static final String TAG_BF2026 = "bf2026";
    /** Nome da campanha nos eventos de analytics. */
    public static final String CAMPAIGN_BF2026 = "bf2026";

    /** Fuso da vigência (Brasil não tem horário de verão desde 2019, mas fica explícito). */
    public static final ZoneId BRASILIA = ZoneId.of("America/Sao_Paulo");
    /** Primeiro dia da campanha (00:00 de Brasília). */
    public static final LocalDate BF2026_FIRST_DAY = LocalDate.of(2026, 11, 20);
    /** Último dia da campanha (até 23:59:59 de Brasília); o cartão fechado volta uma vez nele. */
    public static final LocalDate BF2026_LAST_DAY = LocalDate.of(2026, 12, 1);

    /** Recorrência da fase, nos mesmos valores de {@code ProductDetails.RecurrenceMode}. */
    public static final int RECURRENCE_INFINITE = 1;
    public static final int RECURRENCE_FINITE = 2;
    public static final int RECURRENCE_NON_RECURRING = 3;

    private static final Pattern PERIOD_MONTHS = Pattern.compile("^P(\\d+)M$");
    private static final Pattern PRICE_EN_REAL = Pattern.compile("^R\\$\\s*([0-9]+)\\.([0-9]{2})$");

    private PromoRules() {
    }

    /** Uma fase de preço, copiada de {@code ProductDetails.PricingPhase}. */
    public static final class Phase {
        public final long priceMicros;
        public final String formattedPrice;
        public final String billingPeriod;
        public final int billingCycleCount;
        public final int recurrenceMode;

        public Phase(long priceMicros, String formattedPrice, String billingPeriod,
                     int billingCycleCount, int recurrenceMode) {
            this.priceMicros = priceMicros;
            this.formattedPrice = formattedPrice;
            this.billingPeriod = billingPeriod;
            this.billingCycleCount = billingCycleCount;
            this.recurrenceMode = recurrenceMode;
        }
    }

    /** Uma oferta, copiada de {@code ProductDetails.SubscriptionOfferDetails}. */
    public static final class OfferInfo {
        public final String basePlanId;
        public final String offerId;
        public final String offerToken;
        public final List<String> tags;

        public OfferInfo(String basePlanId, String offerId, String offerToken, List<String> tags) {
            this.basePlanId = basePlanId;
            this.offerId = offerId;
            this.offerToken = offerToken;
            this.tags = tags != null ? tags : Collections.emptyList();
        }
    }

    /**
     * Índice da oferta a usar no base plan, ou -1 se não houver nenhuma.
     *
     * Com {@code preferredTag} presente em alguma oferta do base plan, ela
     * vence. Sem ela, vale a regra de sempre: a primeira oferta do base plan
     * com token. A Play só devolve ofertas para as quais a conta é elegível,
     * então fora da vigência (ou para quem já assinou) a tag simplesmente não
     * aparece e o fluxo é o de hoje.
     */
    public static int chooseOffer(List<OfferInfo> offers, String basePlanId, String preferredTag) {
        if (offers == null) {
            return -1;
        }
        int fallback = -1;
        for (int i = 0; i < offers.size(); i++) {
            OfferInfo offer = offers.get(i);
            if (offer == null || basePlanId == null || !basePlanId.equals(offer.basePlanId)
                    || offer.offerToken == null || offer.offerToken.isEmpty()) {
                continue;
            }
            if (preferredTag != null && offer.tags.contains(preferredTag)) {
                return i;
            }
            if (fallback < 0) {
                fallback = i;
            }
        }
        return fallback;
    }

    /** Preço da Play no formato brasileiro ("R$19.99" num aparelho em inglês vira "R$ 19,99"). */
    public static String normalizePrice(String formattedPrice) {
        if (formattedPrice == null) {
            return "";
        }
        String trimmed = formattedPrice.replace(' ', ' ').trim();
        Matcher real = PRICE_EN_REAL.matcher(trimmed);
        if (real.matches()) {
            return "R$ " + real.group(1) + "," + real.group(2);
        }
        return trimmed;
    }

    /** Meses de um período ISO 8601 mensal ("P1M" = 1); 0 se não for em meses. */
    static int periodMonths(String billingPeriod) {
        if (billingPeriod == null) {
            return 0;
        }
        Matcher m = PERIOD_MONTHS.matcher(billingPeriod.trim());
        if (!m.matches()) {
            return 0;
        }
        try {
            return Integer.parseInt(m.group(1));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Resumo da oferta mensal com desconto: fase promocional, quantos meses
     * ela dura e o preço da fase final. Nulo quando as fases não têm o formato
     * esperado (fase mensal finita paga seguida de fase mensal infinita): aí
     * nada de cartão nem de texto promocional, em vez de um texto errado.
     */
    public static final class Summary {
        public final String promoPrice;
        public final int promoMonths;
        public final String finalPrice;

        Summary(String promoPrice, int promoMonths, String finalPrice) {
            this.promoPrice = promoPrice;
            this.promoMonths = promoMonths;
            this.finalPrice = finalPrice;
        }

        /** "nos 2 primeiros meses" / "no 1º mês". */
        public String durationText() {
            return promoMonths == 1 ? "no 1º mês" : "nos " + promoMonths + " primeiros meses";
        }

        /** Detalhe para a tela de assinatura: "nos 2 primeiros meses. Depois, R$ 24,99/mês." */
        public String detailText() {
            return durationText() + ". Depois, " + finalPrice + "/mês. Cancele quando quiser.";
        }

        /** Subtítulo do cartão da tela inicial. */
        public String cardSubtitle() {
            return "Plano Equipe por " + promoPrice + "/mês " + durationText()
                    + ". Depois, " + finalPrice + "/mês. Cancele quando quiser.";
        }
    }

    public static Summary summarize(List<Phase> phases) {
        if (phases == null || phases.size() < 2) {
            return null;
        }
        Phase promo = phases.get(0);
        Phase last = phases.get(phases.size() - 1);
        if (promo == null || last == null
                || promo.recurrenceMode != RECURRENCE_FINITE
                || last.recurrenceMode != RECURRENCE_INFINITE
                || periodMonths(promo.billingPeriod) != 1
                || periodMonths(last.billingPeriod) != 1
                || promo.billingCycleCount <= 0
                || promo.priceMicros <= 0
                || promo.priceMicros >= last.priceMicros) {
            return null;
        }
        // Mais de uma fase intermediária não cabe numa frase honesta.
        if (phases.size() > 2) {
            return null;
        }
        String promoPrice = normalizePrice(promo.formattedPrice);
        String finalPrice = normalizePrice(last.formattedPrice);
        if (promoPrice.isEmpty() || finalPrice.isEmpty()) {
            return null;
        }
        return new Summary(promoPrice, promo.billingCycleCount, finalPrice);
    }

    /** Data de Brasília de um instante. */
    static LocalDate brasiliaDate(long epochMillis) {
        return java.time.Instant.ofEpochMilli(epochMillis).atZone(BRASILIA).toLocalDate();
    }

    /** Entre 20/11/2026 00:00 e 01/12/2026 23:59:59.999, horário de Brasília. */
    public static boolean inBf2026Window(long epochMillis) {
        long start = ZonedDateTime.of(BF2026_FIRST_DAY.atStartOfDay(), BRASILIA)
                .toInstant().toEpochMilli();
        long endExclusive = ZonedDateTime.of(BF2026_LAST_DAY.plusDays(1).atStartOfDay(), BRASILIA)
                .toInstant().toEpochMilli();
        return epochMillis >= start && epochMillis < endExclusive;
    }

    /**
     * O cartão fechado não volta, exceto uma vez no último dia: se foi
     * fechado antes de 01/12 (Brasília), reaparece em 01/12; fechado de novo
     * nesse dia, some de vez. {@code dismissedAtMillis} 0 = nunca fechado.
     */
    public static boolean reappearsAfterDismiss(long dismissedAtMillis, long nowMillis) {
        if (dismissedAtMillis <= 0) {
            return true;
        }
        LocalDate today = brasiliaDate(nowMillis);
        LocalDate dismissedOn = brasiliaDate(dismissedAtMillis);
        return today.equals(BF2026_LAST_DAY) && dismissedOn.isBefore(BF2026_LAST_DAY);
    }

    /** Regra completa do cartão da tela inicial. */
    public static boolean shouldShowCard(long nowMillis, boolean offerAvailable, boolean subscriber,
                                         boolean canPurchase, long dismissedAtMillis) {
        return inBf2026Window(nowMillis)
                && offerAvailable
                && !subscriber
                && canPurchase
                && reappearsAfterDismiss(dismissedAtMillis, nowMillis);
    }
}
