import { describe, expect, it } from 'vitest';

import { rejectIfFailed } from '../../src/modules/reviews/openai-client.js';
import { AppError } from '../../src/platform/http/errors.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function failure(status: number, body: unknown): Promise<AppError> {
  try {
    await rejectIfFailed(response(status, body));
  } catch (error) {
    return error as AppError;
  }
  throw new Error('deveria ter rejeitado');
}

describe('erros da OpenAI traduzidos para quem opera o painel', () => {
  it('deixa passar respostas boas', async () => {
    await expect(rejectIfFailed(response(200, { ok: true }))).resolves.toBeUndefined();
  });

  it('separa conta sem crédito de limite de chamadas (os dois chegam como 429)', async () => {
    const quota = await failure(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota' } });
    expect(quota.statusCode).toBe(409);
    expect(quota.message).toContain('sem crédito');
    expect(quota.message).toContain('Billing');

    const rate = await failure(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-4o-mini' } });
    expect(rate.statusCode).toBe(429);
    expect(rate.message).toContain('limitando');
    expect(rate.message).toContain('rate_limit_exceeded');
  });

  it('chave recusada e modelo indisponível viram orientação, o resto mostra o motivo do Google', async () => {
    expect((await failure(401, { error: { message: 'Incorrect API key' } })).message).toContain('recusou a chave');
    expect((await failure(403, { error: { code: 'model_not_found', message: 'The model does not exist' } })).message).toContain('modelo');
    const other = await failure(500, { error: { message: 'The server had an error' } });
    expect(other.statusCode).toBe(502);
    expect(other.message).toContain('500: The server had an error');
    const semCorpo = await rejectIfFailed(new Response('oops', { status: 503 })).catch((error: AppError) => error);
    expect((semCorpo as AppError).message).toBe('A OpenAI respondeu 503.');
  });
});
