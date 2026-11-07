import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { notFound, unauthorized, ErrorCode } from '../../platform/http/errors.js';
import { LifecycleService } from './lifecycle.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Estoque Simples</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f7fa;color:#1a2330;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border:1px solid #dde4ec;border-radius:14px;padding:28px;max-width:420px}h1{font-size:1.25rem;margin:0 0 8px}p{line-height:1.5;color:#4a5868}button{background:#1c679d;color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer;width:100%}a{color:#1c679d}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * Verificação da assinatura do webhook do Resend (padrão Svix): HMAC-SHA256
 * de `id.timestamp.corpo` com o segredo `whsec_…` (base64), comparado com
 * cada `v1,<assinatura>` do cabeçalho; carimbo de no máximo 5 minutos.
 */
export function verifySvix(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, now = Date.now()): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${body}`).digest();
  return headers.signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * Rotas públicas do funil de e-mails: descadastro em 1 clique (o GET mostra
 * um botão, para leitores de link não descadastrarem ninguém; o POST é o
 * "One-Click" do `List-Unsubscribe-Post`), aviso de clique vindo do web app e
 * o webhook do Resend (entregue, aberto, clicado, bounce, spam).
 */
export async function registerLifecycleRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new LifecycleService(app.services);
  const tokenQuery = z.object({ t: z.string().regex(UUID) });

  routes.get('/email/descadastrar', { schema: { hide: true, querystring: tokenQuery } }, async (request, reply) => {
    const t = request.query.t;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Não receber mais',
          `<h1>Não receber mais estas mensagens?</h1><p>Você deixa de receber as dicas e lembretes do Estoque Simples. E-mails da sua conta (como a redefinição de senha) continuam chegando.</p><form method="post" action="/v1/email/descadastrar?t=${t}"><button type="submit">Não quero receber</button></form>`,
        ),
      );
  });

  // Descadastro "One-Click" (RFC 8058): o provedor de e-mail e o botão da página mandam
  // um formulário (`List-Unsubscribe=One-Click`); o corpo é ignorado, vale o token.
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(['application/x-www-form-urlencoded', 'text/plain'], { parseAs: 'string', bodyLimit: 4096 }, (_request, body, done) => done(null, body));
    scoped.withTypeProvider<ZodTypeProvider>().post(
      '/email/descadastrar',
      { config: { rateLimit: { max: 20, timeWindow: 60_000 } }, schema: { hide: true, querystring: tokenQuery } },
      async (request, reply) => {
        const ok = await service.unsubscribe(request.query.t);
        return reply
          .type('text/html; charset=utf-8')
          .send(page('Pronto', ok ? '<h1>Pronto</h1><p>Você não vai mais receber estas mensagens.</p><p><a href="/">Voltar ao Estoque Simples</a></p>' : '<h1>Link inválido</h1><p>Este link não é mais válido.</p>'));
      },
    );
  });

  routes.post(
    '/email/clicked',
    {
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: { hide: true, body: z.object({ id: z.string().regex(UUID) }).strict(), response: { 204: z.null() } },
    },
    async (request, reply) => {
      await service.markClicked(request.body.id);
      return reply.code(204).send(null);
    },
  );

  // Corpo cru para conferir a assinatura byte a byte: parser próprio só neste escopo.
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
    scoped.post('/email/resend-webhook', { config: { rateLimit: { max: 300, timeWindow: 60_000 } }, schema: { hide: true } }, async (request, reply) => {
      const secret = request.server.services.env.RESEND_WEBHOOK_SECRET;
      if (!secret) throw notFound('Recurso não encontrado');
      const raw = typeof request.body === 'string' ? request.body : '';
      const ok = verifySvix(
        secret,
        {
          id: request.headers['svix-id'] as string | undefined,
          timestamp: request.headers['svix-timestamp'] as string | undefined,
          signature: request.headers['svix-signature'] as string | undefined,
        },
        raw,
      );
      if (!ok) throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Assinatura inválida.');
      let event: { type?: string; data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string } } };
      try {
        event = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ ok: false });
      }
      const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
      await service.applyProviderEvent({
        type: event.type ?? '',
        providerId: event.data?.email_id ?? null,
        to: to ?? null,
        permanentBounce: (event.data?.bounce?.type ?? 'Permanent').toLowerCase() !== 'transient',
      });
      return reply.send({ ok: true });
    });
  });
}
