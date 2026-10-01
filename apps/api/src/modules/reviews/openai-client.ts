import { AppError, ErrorCode } from '../../platform/http/errors.js';

/**
 * Cliente mínimo da API de chat da OpenAI, só para rascunhar respostas a
 * avaliações. Implementado sobre `fetch`, sem SDK: é uma chamada.
 */
const API_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 30_000;

export interface ReviewDraftInput {
  starRating: number;
  text: string;
  authorName: string | null;
  appVersionName: string | null;
  language: string | null;
  previousReply: string | null;
  instructions: string | null;
  maxLength: number;
}

const SYSTEM_PROMPT = `Você escreve respostas públicas do desenvolvedor a avaliações do aplicativo "Estoque Simples" na Google Play Store.
O Estoque Simples é um app Android brasileiro de controle de estoque para pequenos negócios: cadastro de produtos com foto e código de barras, entradas e saídas, histórico, relatórios em PDF, importação/exportação, e um plano pago (assinatura) que liga a sincronização em nuvem e o uso em equipe com vários aparelhos.
Regras:
- Responda em português do Brasil, no tom de uma pessoa do time: cordial, direto, sem formalidade excessiva e sem emojis.
- Agradeça brevemente, trate o ponto específico que a pessoa levantou e, se houver um problema, diga o que ela pode fazer ou peça detalhes por e-mail (suporte@estoquesimples.com.br).
- Nunca prometa prazos, recursos futuros, reembolsos ou descontos. Não peça para mudar a nota.
- Não invente funcionalidades que o app não tem.
- Máximo de {MAX} caracteres. Não use aspas, títulos, hashtags nem assinatura.`;

export interface SupportDraftInput {
  subject: string;
  category: string;
  userName: string | null;
  signedIn: boolean;
  device: string | null;
  diagnostics: string | null;
  transcript: Array<{ author: string; body: string }>;
  instructions: string | null;
  maxLength: number;
}

const SUPPORT_SYSTEM_PROMPT = `Você é da equipe de suporte do aplicativo Android "Estoque Simples" e escreve a próxima resposta numa solicitação aberta pelo app.
O Estoque Simples é um app brasileiro de controle de estoque para pequenos negócios: cadastro de produtos com foto e código de barras, entradas e saídas, histórico, relatórios em PDF, importação/exportação por planilha, backup, e um plano pago (assinatura pelo Google Play) que liga a sincronização em nuvem e o uso em equipe com vários aparelhos. Sem assinatura os dados ficam só no aparelho.
Regras:
- Responda em português do Brasil, como uma pessoa do time: cordial, direta, sem formalidade excessiva e sem emojis. Trate a pessoa pelo nome se ele for informado.
- Responda ao que foi perguntado. Se for um problema, use o diagnóstico (versão do app, Android, assinatura, sincronização, operações pendentes) para orientar passos concretos; se faltar informação, faça no máximo duas perguntas objetivas.
- Nunca prometa prazos, recursos futuros, reembolsos ou descontos. Reembolsos de assinatura são feitos pelo Google Play.
- Não invente funcionalidades que o app não tem. Não peça senha.
- Texto corrido, sem títulos, listas numeradas longas, assinatura ou aspas. Máximo de {MAX} caracteres.`;

export class OpenAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  /** Chamada barata só para confirmar que a chave é aceita. */
  async verify(): Promise<void> {
    const response = await this.fetchWithTimeout('https://api.openai.com/v1/models?limit=1', {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (response.status === 401) {
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'A OpenAI recusou esta chave.');
    }
    if (!response.ok) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, `A OpenAI respondeu ${response.status} ao validar a chave.`);
    }
  }

  async draftReviewReply(input: ReviewDraftInput): Promise<string> {
    const userMessage = [
      `Nota: ${input.starRating} de 5 estrelas.`,
      input.authorName ? `Nome de quem avaliou: ${input.authorName}.` : null,
      input.appVersionName ? `Versão do app usada: ${input.appVersionName}.` : null,
      input.language && !input.language.toLowerCase().startsWith('pt')
        ? `Idioma da avaliação: ${input.language} (responda nesse idioma).`
        : null,
      input.previousReply ? `Já existe uma resposta anterior, que será substituída: "${input.previousReply}"` : null,
      input.instructions ? `Orientação de quem vai responder: ${input.instructions}` : null,
      '',
      'Avaliação:',
      input.text.trim().length > 0 ? input.text.trim() : '(a pessoa só deu a nota, sem texto)',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const response = await this.fetchWithTimeout(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.6,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT.replace('{MAX}', String(input.maxLength)) },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (response.status === 401) {
      throw new AppError(409, ErrorCode.CONFLICT, 'A OpenAI recusou a chave configurada. Cadastre uma nova.');
    }
    if (response.status === 429) {
      throw new AppError(429, ErrorCode.RATE_LIMITED, 'A OpenAI está limitando as chamadas. Tente em instantes.');
    }
    if (!response.ok) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, `A OpenAI respondeu ${response.status}.`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'A OpenAI não devolveu texto.');
    }
    // Garantia final do limite do Google, mesmo que o modelo passe do ponto.
    return text.length > input.maxLength ? `${text.slice(0, input.maxLength - 1).trimEnd()}…` : text;
  }

  /**
   * Rascunho de resposta a uma solicitação de suporte, a partir da conversa
   * e do diagnóstico que o app mandou. Quem atende revisa antes de enviar.
   */
  async draftSupportReply(input: SupportDraftInput): Promise<string> {
    const context = [
      `Assunto: ${input.subject}`,
      `Categoria: ${input.category}`,
      input.userName ? `Nome da pessoa: ${input.userName}.` : 'A pessoa não informou o nome.',
      input.signedIn ? 'A pessoa tem conta no app.' : 'A pessoa usa o app sem conta (dados só no aparelho).',
      input.device ? `Aparelho: ${input.device}.` : null,
      input.diagnostics ? `Diagnóstico enviado pelo app: ${input.diagnostics}` : null,
      input.instructions ? `Orientação de quem vai responder: ${input.instructions}` : null,
      '',
      'Conversa até agora (mais antiga primeiro):',
      ...input.transcript.map((entry) => `[${entry.author}] ${entry.body}`),
    ]
      .filter((line) => line !== null)
      .join('\n');

    const text = await this.complete(SUPPORT_SYSTEM_PROMPT.replace('{MAX}', String(input.maxLength)), context, 700);
    return text.length > input.maxLength ? `${text.slice(0, input.maxLength - 1).trimEnd()}…` : text;
  }

  private async complete(system: string, user: string, maxTokens: number): Promise<string> {
    const response = await this.fetchWithTimeout(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.5,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (response.status === 401) {
      throw new AppError(409, ErrorCode.CONFLICT, 'A OpenAI recusou a chave configurada. Cadastre uma nova.');
    }
    if (response.status === 429) {
      throw new AppError(429, ErrorCode.RATE_LIMITED, 'A OpenAI está limitando as chamadas. Tente em instantes.');
    }
    if (!response.ok) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, `A OpenAI respondeu ${response.status}.`);
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'A OpenAI não devolveu texto.');
    }
    return text;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'Não foi possível falar com a OpenAI agora.', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
