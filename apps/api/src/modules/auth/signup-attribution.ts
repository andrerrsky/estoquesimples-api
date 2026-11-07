import { z } from 'zod';

/**
 * Origem do cadastro pela web.
 *
 * A página guarda na aba (sessionStorage, sem cookie) os parâmetros de
 * campanha com que a pessoa chegou e os envia no POST de cadastro. A API
 * grava em `users.signup_attribution` para:
 *
 *   - mostrar no painel de onde veio cada conta e calcular o custo por
 *     ativação de cada campanha, sem depender do banner de cookies;
 *   - para quem **aceitou** os cookies na versão que menciona anúncios
 *     (`consent = v2_accepted`), informar ao Google Ads que o clique virou
 *     ativação (importação de conversões offline por `gclid`). Quem recusou,
 *     nunca escolheu ou aceitou o texto antigo não é enviado.
 *
 * Só uma lista fechada de chaves, valores curtos e sem `@`: nada de e-mail,
 * nome ou URL completa entra por aqui.
 */
export const ATTRIBUTION_CONSENT = ['v2_accepted', 'v1_accepted', 'refused', 'none'] as const;
export type AttributionConsent = (typeof ATTRIBUTION_CONSENT)[number];

const utm = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .refine((value) => !value.includes('@'), 'Valor inválido.');
/** Identificadores de clique do Google: letras, números, `-`, `_` e `.`. */
const clickId = z.string().trim().regex(/^[A-Za-z0-9_\-.]{1,300}$/);

export const signupAttributionSchema = z
  .object({
    utm_source: utm.optional(),
    utm_medium: utm.optional(),
    utm_campaign: utm.optional(),
    utm_content: utm.optional(),
    utm_term: utm.optional(),
    utm_id: utm.optional(),
    gclid: clickId.optional(),
    gbraid: clickId.optional(),
    wbraid: clickId.optional(),
    /** Caminho da primeira página (sem query string), ex.: `/` ou `/blog/x`. */
    landing: z.string().trim().regex(/^\/[A-Za-z0-9_\-./]{0,199}$/).optional(),
    consent: z.enum(ATTRIBUTION_CONSENT).optional(),
  })
  .strict();

export type SignupAttribution = z.infer<typeof signupAttributionSchema>;

const CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'gclid', 'gbraid', 'wbraid'] as const;

/**
 * O que vai para o banco: só quando há campanha (UTM ou clique). Visita
 * direta não grava nada — a escolha de cookies sozinha não diz de onde a
 * pessoa veio.
 */
export function attributionToStore(input: SignupAttribution | undefined, now: Date): Record<string, string> | null {
  if (!input) return null;
  if (!CAMPAIGN_KEYS.some((key) => input[key])) return null;
  const stored: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value !== '') stored[key] = value;
  }
  stored.consent = input.consent ?? 'none';
  stored.at = now.toISOString();
  return stored;
}

/**
 * Propriedades para o evento `user.registered`: UTMs e se houve clique em
 * anúncio, nunca o identificador do clique.
 */
export function attributionEventProperties(stored: Record<string, string> | null): Record<string, string | boolean> {
  if (!stored) return {};
  const props: Record<string, string | boolean> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const) {
    if (stored[key]) props[key] = stored[key];
  }
  props.has_click_id = Boolean(stored.gclid || stored.gbraid || stored.wbraid);
  return props;
}

/** `2026-11-07 14:32:10-03:00`: o formato que o upload do Google Ads aceita, sempre em Brasília. */
export function adsConversionTime(date: Date): string {
  const brasilia = new Date(date.getTime() - 3 * 3_600_000);
  const iso = brasilia.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}-03:00`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface OfflineConversionRow {
  gclid: string;
  convertedAt: Date;
}

/** Valor estimado de uma ativação (ver docs/aquisicao-e-conversao.md). */
export const ACTIVATION_VALUE_BRL = 12;
export const ACTIVATION_CONVERSION_NAME = 'Ativação (offline)';

/** CSV no modelo "Conversões de cliques" do Google Ads (Ferramentas › Uploads). */
export function offlineConversionsCsv(rows: OfflineConversionRow[], conversionName = ACTIVATION_CONVERSION_NAME): string {
  const lines = ['Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'];
  for (const row of rows) {
    lines.push([row.gclid, conversionName, adsConversionTime(row.convertedAt), String(ACTIVATION_VALUE_BRL), 'BRL'].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
