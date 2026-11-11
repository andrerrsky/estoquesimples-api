package br.com.gameloop.estoquesimples.billing;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.time.ZonedDateTime;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import br.com.gameloop.estoquesimples.billing.PromoRules.OfferInfo;
import br.com.gameloop.estoquesimples.billing.PromoRules.Phase;
import br.com.gameloop.estoquesimples.billing.PromoRules.Summary;

public class PromoRulesTest {

    private static final String BASE = "plano-basico";

    private static long brt(int year, int month, int day, int hour, int minute, int second) {
        return ZonedDateTime.of(year, month, day, hour, minute, second, 0, PromoRules.BRASILIA)
                .toInstant().toEpochMilli();
    }

    private static OfferInfo offer(String basePlan, String offerId, String token, String... tags) {
        return new OfferInfo(basePlan, offerId, token, Arrays.asList(tags));
    }

    private static Phase promo(long micros, String price, int cycles) {
        return new Phase(micros, price, "P1M", cycles, PromoRules.RECURRENCE_FINITE);
    }

    private static Phase full(long micros, String price) {
        return new Phase(micros, price, "P1M", 0, PromoRules.RECURRENCE_INFINITE);
    }

    // --- escolha da oferta pela tag ---

    @Test
    public void tagOfferWinsOverIntroOffer() {
        List<OfferInfo> offers = Arrays.asList(
                offer(BASE, "entrada", "t-entrada", "entrada"),
                offer(BASE, null, "t-base"),
                offer(BASE, "bf", "t-bf", "outra", "bf2026"));
        assertEquals(2, PromoRules.chooseOffer(offers, BASE, PromoRules.TAG_BF2026));
    }

    @Test
    public void withoutTagKeepsTodaysFirstOfferOfBasePlan() {
        List<OfferInfo> offers = Arrays.asList(
                offer("outro-plano", "x", "t-x", "bf2026"),
                offer(BASE, "entrada", "t-entrada", "entrada"),
                offer(BASE, null, "t-base"));
        assertEquals(1, PromoRules.chooseOffer(offers, BASE, PromoRules.TAG_BF2026));
        assertEquals(1, PromoRules.chooseOffer(offers, BASE, null));
    }

    @Test
    public void tagOnOtherBasePlanOrWithoutTokenIsIgnored() {
        List<OfferInfo> offers = Arrays.asList(
                offer(BASE, "bf", "", "bf2026"),
                offer(BASE, null, "t-base"));
        assertEquals(1, PromoRules.chooseOffer(offers, BASE, PromoRules.TAG_BF2026));
        assertEquals(-1, PromoRules.chooseOffer(Collections.emptyList(), BASE, "bf2026"));
        assertEquals(-1, PromoRules.chooseOffer(null, BASE, "bf2026"));
    }

    // --- texto a partir das fases ---

    @Test
    public void cardSubtitleComesFromPhases() {
        Summary s = PromoRules.summarize(Arrays.asList(
                promo(9_990_000L, "R$ 9,99", 2), full(24_990_000L, "R$ 24,99")));
        assertEquals("Plano Equipe por R$ 9,99/mês nos 2 primeiros meses. Depois, R$ 24,99/mês. "
                + "Cancele quando quiser.", s.cardSubtitle());
        assertEquals("nos 2 primeiros meses. Depois, R$ 24,99/mês. Cancele quando quiser.",
                s.detailText());
    }

    @Test
    public void priceFromEnglishDeviceAndOneMonthAreFormatted() {
        Summary s = PromoRules.summarize(Arrays.asList(
                promo(12_490_000L, "R$12.49", 1), full(29_900_000L, "R$ 29,90")));
        assertEquals("Plano Equipe por R$ 12,49/mês no 1º mês. Depois, R$ 29,90/mês. "
                + "Cancele quando quiser.", s.cardSubtitle());
    }

    @Test
    public void unexpectedPhasesGiveNoText() {
        // Uma fase só (sem desconto).
        assertNull(PromoRules.summarize(Collections.singletonList(full(24_990_000L, "R$ 24,99"))));
        // Teste grátis (preço zero).
        assertNull(PromoRules.summarize(Arrays.asList(
                promo(0L, "Gratuito", 1), full(24_990_000L, "R$ 24,99"))));
        // Fase promocional trimestral: "/mês" seria mentira.
        assertNull(PromoRules.summarize(Arrays.asList(
                new Phase(9_990_000L, "R$ 9,99", "P3M", 1, PromoRules.RECURRENCE_FINITE),
                full(24_990_000L, "R$ 24,99"))));
        // "Desconto" mais caro que o preço final.
        assertNull(PromoRules.summarize(Arrays.asList(
                promo(30_000_000L, "R$ 30,00", 2), full(24_990_000L, "R$ 24,99"))));
        // Três fases.
        assertNull(PromoRules.summarize(Arrays.asList(
                promo(9_990_000L, "R$ 9,99", 2), promo(19_990_000L, "R$ 19,99", 1),
                full(24_990_000L, "R$ 24,99"))));
        assertNull(PromoRules.summarize(null));
    }

    @Test
    public void periodParsing() {
        assertEquals(1, PromoRules.periodMonths("P1M"));
        assertEquals(12, PromoRules.periodMonths("P12M"));
        assertEquals(0, PromoRules.periodMonths("P1Y"));
        assertEquals(0, PromoRules.periodMonths("P1W"));
        assertEquals(0, PromoRules.periodMonths(null));
    }

    // --- janela de datas (Brasília) ---

    @Test
    public void windowIsInBrasiliaTime() {
        assertFalse(PromoRules.inBf2026Window(brt(2026, 11, 19, 23, 59, 59)));
        assertTrue(PromoRules.inBf2026Window(brt(2026, 11, 20, 0, 0, 0)));
        assertTrue(PromoRules.inBf2026Window(brt(2026, 12, 1, 23, 59, 59)));
        assertFalse(PromoRules.inBf2026Window(brt(2026, 12, 2, 0, 0, 0)));
        // 20/11 02:59:59 UTC ainda é 19/11 em Brasília (UTC-3).
        long utc = ZonedDateTime.of(2026, 11, 20, 2, 59, 59, 0, java.time.ZoneOffset.UTC)
                .toInstant().toEpochMilli();
        assertFalse(PromoRules.inBf2026Window(utc));
        assertTrue(PromoRules.inBf2026Window(utc + 1000L));
    }

    // --- cartão fechado: volta uma vez em 01/12 ---

    @Test
    public void dismissedCardStaysHiddenUntilLastDay() {
        long fechado = brt(2026, 11, 21, 10, 0, 0);
        assertTrue(PromoRules.reappearsAfterDismiss(0L, brt(2026, 11, 22, 10, 0, 0)));
        assertFalse(PromoRules.reappearsAfterDismiss(fechado, brt(2026, 11, 21, 10, 5, 0)));
        assertFalse(PromoRules.reappearsAfterDismiss(fechado, brt(2026, 11, 30, 23, 59, 59)));
        assertTrue(PromoRules.reappearsAfterDismiss(fechado, brt(2026, 12, 1, 0, 0, 0)));
    }

    @Test
    public void dismissedOnLastDayDoesNotComeBack() {
        long fechadoNoUltimoDia = brt(2026, 12, 1, 9, 0, 0);
        assertFalse(PromoRules.reappearsAfterDismiss(fechadoNoUltimoDia, brt(2026, 12, 1, 20, 0, 0)));
    }

    @Test
    public void fullCardRule() {
        long agora = brt(2026, 11, 25, 12, 0, 0);
        assertTrue(PromoRules.shouldShowCard(agora, true, false, true, 0L));
        assertFalse(PromoRules.shouldShowCard(agora, false, false, true, 0L));
        assertFalse(PromoRules.shouldShowCard(agora, true, true, true, 0L));
        assertFalse(PromoRules.shouldShowCard(agora, true, false, false, 0L));
        assertFalse(PromoRules.shouldShowCard(agora, true, false, true, agora - 1000L));
        assertFalse(PromoRules.shouldShowCard(brt(2026, 12, 2, 0, 0, 0), true, false, true, 0L));
        assertFalse(PromoRules.shouldShowCard(brt(2026, 11, 19, 12, 0, 0), true, false, true, 0L));
    }
}
