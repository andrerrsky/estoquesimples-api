import { asc, eq } from 'drizzle-orm';

import { planFeatures, plans } from '../../platform/db/schema/index.js';
import type { Database } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { relatedHelpArticles } from '../blog/help-content.js';
import { PRODUCT_FACT_LINES } from '../blog/product-facts.js';
import { Feature } from '../billing/plan-limits.js';
import { OpenAiClient } from '../reviews/openai-client.js';

/**
 * A IA que responde sozinha no atendimento.
 *
 * O prompt é montado em duas partes, e nenhuma delas tem número escrito à
 * mão:
 *
 * - **O que o produto faz**: `PRODUCT_FACT_LINES` (`modules/blog/product-facts.ts`),
 *   a mesma fonte única que a IA do blog e o `llms.txt` usam.
 * - **Planos, limites e preços**: lidos de `plans` e `plan_features` a cada
 *   resposta — as mesmas linhas que o dono edita em **Painel › Planos**, que
 *   é a fonte da verdade (ver seção 2 do CLAUDE.md). Mudar o preço no painel
 *   muda o que a IA diz, sem deploy.
 *
 * O tom e as regras de atendimento são os da seção 4 do CLAUDE.md, iguais
 * para a IA e para quem atende: resposta curta, resolver do nosso lado,
 * reembolso só se o cliente pedir, nada de cupom, só o primeiro nome.
 */

/** Teto da resposta automática: mais curta que a de uma pessoa, de propósito. */
export const AI_REPLY_MAX_LENGTH = 700;

/** Quantas respostas a IA pode dar na mesma solicitação antes de chamar uma pessoa. */
export const AI_MAX_REPLIES_PER_TICKET = 3;

/**
 * O que a IA devolve. `human` é o valor combinado do escalonamento: nada é
 * enviado ao cliente, a solicitação é marcada como "precisa de humano" e o
 * dono recebe o aviso por e-mail.
 */
export type SupportAiOutcome = { action: 'reply'; text: string } | { action: 'human'; reason: string };

export interface SupportAiInput {
  subject: string;
  category: string;
  /** Só o primeiro nome: é o que a regra de atendimento permite usar. */
  firstName: string | null;
  signedIn: boolean;
  planLabel: string | null;
  device: string | null;
  diagnostics: string | null;
  transcript: Array<{ author: 'user' | 'support' | 'system'; body: string }>;
}

const REAIS = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Nome legível das chaves de `plan_features` que o cliente pergunta. */
const FEATURE_LABEL: Record<string, string> = {
  [Feature.SYNC]: 'sincronização na nuvem',
  [Feature.PRODUCTS]: 'produtos sincronizados na nuvem',
  [Feature.MEMBERS]: 'pessoas na empresa',
  [Feature.DEVICES]: 'aparelhos sincronizados',
  [Feature.ANALYSIS]: 'análise avançada',
  [Feature.IMAGES_MB]: 'armazenamento de fotos (MB)',
};

/**
 * Planos, limites e preços como estão agora no banco. Texto curto, em
 * português, para entrar no prompt — e sempre com o aviso de que `null` é
 * "sem limite", como a coluna `limit_value` define.
 */
export async function planFactsFor(db: Database): Promise<string> {
  const [planRows, featureRows] = await Promise.all([
    db.select().from(plans).where(eq(plans.isActive, true)).orderBy(asc(plans.createdAt)),
    db.select().from(planFeatures),
  ]);
  if (planRows.length === 0) return '(os planos não foram lidos do banco; não cite limites nem preços)';

  return planRows
    .map((plan) => {
      const features = featureRows
        .filter((row) => row.planKey === plan.key)
        .map((row) => {
          const label = FEATURE_LABEL[row.featureKey] ?? row.featureKey;
          if (!row.enabled) return `${label}: não`;
          return `${label}: ${row.limitValue === null ? 'sem limite' : row.limitValue}`;
        });
      const prices = [
        plan.webPriceMonthlyCents ? `mensal ${REAIS.format(plan.webPriceMonthlyCents / 100)}` : null,
        plan.webPriceSemiannualCents ? `semestral ${REAIS.format(plan.webPriceSemiannualCents / 100)} (total)` : null,
        plan.webPriceYearlyCents ? `anual ${REAIS.format(plan.webPriceYearlyCents / 100)} (total)` : null,
      ].filter((line) => line !== null);
      const offer =
        plan.googleOfferPriceCents && plan.googleOfferCycles
          ? `Oferta de entrada no app Android: ${REAIS.format(plan.googleOfferPriceCents / 100)} por mês nos ${plan.googleOfferCycles} primeiros meses.`
          : null;
      return [
        `Plano "${plan.name}" (chave ${plan.key})${plan.description ? `: ${plan.description}` : ''}`,
        features.length > 0 ? `  Limites: ${features.join('; ')}.` : null,
        prices.length > 0 ? `  Preço na web (Pix, boleto ou cartão): ${prices.join(' · ')}.` : '  Não é vendido pela web.',
        offer ? `  ${offer}` : null,
      ]
        .filter((line) => line !== null)
        .join('\n');
    })
    .join('\n');
}

/** As duas frases que valem em qualquer resposta sobre assinatura. */
const SUBSCRIPTION_FACTS = [
  'A assinatura é da empresa, não da pessoa: vale no app Android e na versão web ao mesmo tempo, qualquer que seja o canal de compra.',
  'Não se cobra por pessoa: o plano pago não tem limite de gente na empresa.',
];

export function supportAiSystemPrompt(planFacts: string): string {
  return [
    'Você é do time de atendimento do Estoque Simples e responde ao cliente no chat de suporte, em português do Brasil.',
    '',
    'O QUE O PRODUTO É E FAZ (só pode citar o que está aqui):',
    ...PRODUCT_FACT_LINES.map((line) => `- ${line}`),
    '',
    'PLANOS, LIMITES E PREÇOS EM VIGOR (lidos agora do sistema; não invente nem arredonde nenhum número):',
    planFacts,
    ...SUBSCRIPTION_FACTS.map((line) => `- ${line}`),
    '- O plano pago chama-se Equipe. Não existe plano "Pro"; quem diz "plano pró" quer dizer Equipe.',
    '',
    'COMO ATENDER:',
    '- Resposta curta e objetiva: uma ou duas frases quando isso resolve. Nada de textão, saudação longa, passo a passo extenso nem assinatura.',
    '- Resolva do nosso lado sempre que possível. Não peça print, número de pedido nem tarefa ao cliente só para confirmar o que já se sabe.',
    '- Nunca ofereça reembolso, desconto ou cupom. Se o cliente pedir reembolso, é caso de pessoa.',
    '- Trate a pessoa só pelo primeiro nome, quando ele for informado. Nunca escreva o e-mail dela.',
    '- Não prometa prazo, funcionalidade futura nem nada que o produto não faz hoje.',
    '- Cliente insatisfeito ou falando de cancelamento: acalme, pergunte o motivo e tente resolver o problema de verdade — sem prometer nada.',
    '- Sem emoji, sem aspas, sem título, sem markdown.',
    `- No máximo ${AI_REPLY_MAX_LENGTH} caracteres.`,
    '',
    'QUANDO CHAMAR UMA PESSOA (responda com acao="humano"):',
    '- Reembolso, estorno, cancelamento de cobrança, troca de forma de pagamento, nota fiscal, qualquer dado de cobrança da conta.',
    '- Bug, erro, perda de dado, sincronização que não funciona, algo que exige olhar o sistema.',
    '- Pedido de funcionalidade, proposta comercial, imprensa, parceria, assunto jurídico ou de privacidade.',
    '- Qualquer pergunta cuja resposta não esteja nos fatos acima, ou sobre a conta específica do cliente.',
    '- Na dúvida, chame a pessoa. Responder errado é pior do que demorar.',
    '',
    'FORMATO DA RESPOSTA — um objeto JSON, sem mais nada:',
    '{"acao": "responder", "resposta": "o texto que o cliente vai ler"}',
    'ou',
    '{"acao": "humano", "motivo": "em poucas palavras, por que precisa de uma pessoa"}',
  ].join('\n');
}

function userMessage(input: SupportAiInput, help: string): string {
  return [
    `Assunto: ${input.subject}`,
    `Categoria: ${input.category}`,
    input.firstName ? `Primeiro nome do cliente: ${input.firstName}.` : 'O cliente não informou o nome.',
    input.signedIn ? 'O cliente tem conta.' : 'O cliente está sem conta (os dados ficam só no aparelho dele).',
    input.planLabel ? `Plano atual da empresa dele: ${input.planLabel}.` : null,
    input.device ? `De onde escreveu: ${input.device}.` : null,
    input.diagnostics ? `Diagnóstico enviado pelo aplicativo: ${input.diagnostics}` : null,
    '',
    'Trechos da central de ajuda relacionados à dúvida (use como base da resposta):',
    help,
    '',
    'Conversa até agora (mais antiga primeiro; a última mensagem é a que você precisa responder):',
    ...input.transcript.map((entry) => `[${entry.author === 'user' ? 'cliente' : entry.author === 'support' ? 'nós' : 'sistema'}] ${entry.body}`),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Os artigos da ajuda ligados à dúvida, no formato que entra no prompt. */
function helpFor(input: SupportAiInput): string {
  const question = [input.subject, ...input.transcript.filter((entry) => entry.author === 'user').map((entry) => entry.body)].join(' ');
  const related = relatedHelpArticles(question, 6);
  if (related.length === 0) return '(nenhum artigo da ajuda relacionado — se a resposta não estiver nos fatos, chame uma pessoa)';
  return related.map((article) => `- ${article.question}\n  ${article.answer.join(' ').slice(0, 700)}`).join('\n');
}

export class SupportAiAgent {
  constructor(private readonly services: AppServices) {}

  /**
   * Uma chamada à OpenAI, com a mesma chave e o mesmo modelo do resto do
   * painel (`openai-client.ts`). Qualquer falha — chave recusada, conta sem
   * crédito, tempo-limite, JSON estranho, resposta vazia — termina em
   * escalonamento silencioso: é melhor a solicitação cair na mão de uma
   * pessoa do que o cliente receber uma resposta errada.
   */
  async answer(apiKey: string, input: SupportAiInput): Promise<SupportAiOutcome> {
    const client = new OpenAiClient(apiKey, this.services.env.OPENAI_MODEL);
    const system = supportAiSystemPrompt(await planFactsFor(this.services.db));

    let raw: unknown;
    try {
      raw = await client.completeJson(system, userMessage(input, helpFor(input)), 600, 0.3);
    } catch (error) {
      this.services.logger?.warn({ err: error }, 'IA do atendimento falhou; solicitação encaminhada a uma pessoa');
      return { action: 'human', reason: 'A IA não conseguiu responder (falha ao falar com a OpenAI).' };
    }

    const body = (raw ?? {}) as { acao?: unknown; resposta?: unknown; motivo?: unknown };
    const action = typeof body.acao === 'string' ? body.acao.trim().toLowerCase() : '';
    if (action === 'humano') {
      const reason = typeof body.motivo === 'string' && body.motivo.trim().length > 0 ? body.motivo.trim() : 'A IA não soube responder.';
      return { action: 'human', reason: reason.slice(0, 300) };
    }
    const text = typeof body.resposta === 'string' ? body.resposta.trim() : '';
    if (action !== 'responder' || text.length < 2) {
      return { action: 'human', reason: 'A IA devolveu uma resposta que não dá para enviar.' };
    }
    // Garantia final do tamanho, mesmo que o modelo passe do ponto.
    return { action: 'reply', text: text.length > AI_REPLY_MAX_LENGTH ? `${text.slice(0, AI_REPLY_MAX_LENGTH - 1).trimEnd()}…` : text };
  }
}
