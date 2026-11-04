import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashPassword } from '../../src/platform/auth/password.js';
import { platformAdmins } from '../../src/platform/db/schema/index.js';
import { startJobRunner } from '../../src/platform/jobs/runner.js';
import { createTestApp, resetDatabase, type TestContext } from '../helpers/test-app.js';

const PASSWORD = 'PainelSeguro#2026';
const CSRF = { 'x-requested-with': 'estoquesimples-admin' };

let context: TestContext;
let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'capas-'));
  context = await createTestApp({ IMAGE_FS_DIR: storageDir });
});

afterAll(async () => {
  await context.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase(context);
});

async function ownerCookie(): Promise<string> {
  const email = `owner.${randomUUID()}@exemplo.com.br`;
  await context.services.db.insert(platformAdmins).values({ email, name: 'Dono', passwordHash: await hashPassword(PASSWORD), role: 'owner' });
  const login = await context.app.inject({ method: 'POST', url: '/admin/api/auth/login', headers: CSRF, payload: { email, password: PASSWORD } });
  const raw = login.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
}

describe('capa do post gerada pela IA', () => {
  it('descreve a cena, gera a foto (caindo para o dall-e-3), recorta em 1200×630 e grava o texto alternativo', async () => {
    const cookie = await ownerCookie();
    const foto = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();
    const pedidosImagem: Array<{ model: string; size: string }> = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.openai.com/v1/models')) return new Response('{}', { status: 200 });
      if (url.startsWith('https://api.openai.com/v1/chat/completions')) {
        const cena = { scene: 'Hands of a shop owner counting bags of roasted coffee on a wooden shelf in a small Brazilian grocery store, morning light through the window, shallow depth of field.', alt: 'Mãos contando pacotes de café numa prateleira de mercearia' };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(cena) } }] }), { status: 200 });
      }
      if (url.startsWith('https://api.openai.com/v1/images/generations')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; size: string; prompt: string };
        pedidosImagem.push({ model: body.model, size: body.size });
        if (body.model === 'gpt-image-1') {
          return new Response(JSON.stringify({ error: { message: 'Your organization must be verified to use the model `gpt-image-1`.', type: 'invalid_request_error' } }), { status: 403 });
        }
        expect(body.prompt).toContain('no text');
        return new Response(JSON.stringify({ data: [{ b64_json: foto.toString('base64') }] }), { status: 200 });
      }
      return realFetch(input, init);
    });
    const stop = startJobRunner(context.services, context.app.log, { intervalMs: 50 });
    try {
      expect((await context.app.inject({ method: 'PUT', url: '/admin/api/settings/openai', headers: { cookie, ...CSRF }, payload: { apiKey: `sk-${'b'.repeat(40)}` } })).statusCode).toBe(200);
      const created = await context.app.inject({
        method: 'POST',
        url: '/admin/api/blog/posts',
        headers: { cookie, ...CSRF },
        payload: {
          title: 'Estoque parado: como identificar e resolver',
          excerpt: 'Como descobrir o que está parado no estoque e o que fazer para transformar em dinheiro de novo.',
          contentMd: `## Estoque parado\n\n${'Texto do post sobre estoque parado em pequenos negócios. '.repeat(10)}`,
          category: 'financas',
        },
      });
      expect(created.statusCode).toBe(201);
      const postId = (created.json() as { id: string }).id;

      const pedido = await context.app.inject({ method: 'POST', url: `/admin/api/blog/posts/${postId}/cover/ai`, headers: { cookie, ...CSRF } });
      expect(pedido.statusCode).toBe(200);
      const { jobId, reused } = pedido.json() as { jobId: string; reused: boolean };
      expect(reused).toBe(false);
      // Segundo clique enquanto roda: acompanha o mesmo pedido.
      const repetido = await context.app.inject({ method: 'POST', url: `/admin/api/blog/posts/${postId}/cover/ai`, headers: { cookie, ...CSRF } });
      expect(repetido.json()).toMatchObject({ jobId, reused: true });

      type Detail = { job: { status: string; lastError: string | null; result: Record<string, unknown> | null }; logs: Array<{ message: string }> };
      let detail: Detail | null = null;
      for (let i = 0; i < 100; i += 1) {
        detail = (await context.app.inject({ method: 'GET', url: `/admin/api/ops/jobs/${jobId}`, headers: { cookie } })).json() as Detail;
        if (detail.job.status === 'completed' || detail.job.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(detail!.job.lastError).toBeNull();
      expect(detail!.job.status).toBe('completed');
      expect(pedidosImagem).toEqual([{ model: 'gpt-image-1', size: '1536x1024' }, { model: 'dall-e-3', size: '1792x1024' }]);
      const mensagens = detail!.logs.map((line) => line.message);
      expect(mensagens.some((line) => line.startsWith('Cena: Hands of a shop owner'))).toBe(true);
      expect(mensagens.some((line) => /^Foto gerada com dall-e-3 \(o gpt-image-1 não está liberado/.test(line))).toBe(true);

      const post = (await context.app.inject({ method: 'GET', url: `/admin/api/blog/posts/${postId}`, headers: { cookie } })).json() as { coverUrl: string; coverAuto: boolean; coverAlt: string };
      expect(post.coverAuto).toBe(false);
      expect(post.coverAlt).toBe('Mãos contando pacotes de café numa prateleira de mercearia');
      expect(detail!.job.result?.['coverUrl']).toBe(post.coverUrl);
      const imagem = await context.app.inject({ method: 'GET', url: post.coverUrl });
      expect(imagem.statusCode).toBe(200);
      const meta = await sharp(imagem.rawPayload).metadata();
      expect({ width: meta.width, height: meta.height }).toEqual({ width: 1200, height: 630 });
    } finally {
      stop();
      spy.mockRestore();
    }
  });
});
