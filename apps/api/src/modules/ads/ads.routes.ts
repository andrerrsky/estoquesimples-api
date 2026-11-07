import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { safeEquals } from '../../platform/auth/tokens.js';
import { notFound, unauthorized, ErrorCode } from '../../platform/http/errors.js';
import { AdminUsersService } from '../admin/admin-users.service.js';
import { offlineConversionsCsv } from '../auth/signup-attribution.js';

/** Usuário fixo do upload programado; a senha vem de `ADS_UPLOAD_PASSWORD`. */
export const ADS_UPLOAD_USER = 'googleads';
/**
 * O assistente da Central de dados só aceita a conexão se o arquivo tiver ao
 * menos uma linha (para descobrir o formato). Até este horário, sem ativações
 * reais, sai uma linha de configuração com um gclid que não existe: o Google
 * a recusa no upload e nada é contado. Depois disso, nunca mais.
 */
export const SCHEMA_SAMPLE_UNTIL = new Date('2026-11-07T19:00:00Z');
const SCHEMA_SAMPLE_GCLID = 'TESTE_CONFIGURACAO_IGNORAR';

/** O Google busca 1×/dia; uma janela de 7 dias cobre falhas e é deduplicada por ele (mesmo gclid + ação). */
const WINDOW_DAYS = 7;

function requireUploadPassword(request: FastifyRequest, reply: FastifyReply): void {
  const expected = request.server.services.env.ADS_UPLOAD_PASSWORD;
  // Sem senha configurada o recurso não existe, em vez de ficar aberto.
  if (!expected) throw notFound('Recurso não encontrado');
  const header = request.headers.authorization ?? '';
  const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6).trim(), 'base64').toString('utf8') : '';
  const separator = decoded.indexOf(':');
  const user = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';
  const ok = safeEquals(user, ADS_UPLOAD_USER) && safeEquals(password, expected);
  if (!ok) {
    // O desafio é obrigatório: clientes como o conector HTTPS do Google Ads
    // só mandam usuário e senha depois de receberem este cabeçalho.
    reply.header('WWW-Authenticate', 'Basic realm="estoquesimples-ads", charset="UTF-8"');
    throw unauthorized(ErrorCode.AUTH_REQUIRED, 'Credenciais inválidas.');
  }
}

/**
 * Upload programado de conversões offline do Google Ads: o mesmo CSV do
 * botão do painel (ativações de quem veio por anúncio e aceitou o aviso de
 * cookies atual; ver `AdminUsersService.offlineActivations`), buscado pelo
 * próprio Google com autenticação básica. Só gclid e horários: nenhum dado
 * pessoal sai por aqui.
 */
export async function registerAdsRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new AdminUsersService(app.services);

  routes.get(
    '/ads/offline-conversions.csv',
    {
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: { tags: ['ads'], summary: 'CSV de ativações para o upload programado do Google Ads', hide: true },
    },
    async (request, reply) => {
      requireUploadPassword(request, reply);
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
      let rows = await service.offlineActivations(since);
      if (rows.length === 0 && Date.now() < SCHEMA_SAMPLE_UNTIL.getTime()) {
        rows = [{ gclid: SCHEMA_SAMPLE_GCLID, convertedAt: new Date(Date.now() - 86_400_000) }];
      }
      const csv = offlineConversionsCsv(rows);
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Cache-Control', 'no-store').send(csv);
    },
  );
}
