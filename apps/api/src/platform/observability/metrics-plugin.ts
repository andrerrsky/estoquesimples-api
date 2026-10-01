import fp from 'fastify-plugin';

import { recordHttpRequest } from './metrics.js';

/**
 * Contabiliza toda resposta HTTP.
 *
 * O rótulo de rota é o padrão registrado (`/v1/workspaces/:workspaceId/sync/push`),
 * nunca a URL concreta. Com a URL, cada empresa criaria uma série temporal
 * própria e a coleta viraria inutilizável em poucos dias.
 */
export const metricsPlugin = fp(async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const rota = request.routeOptions?.url ?? 'desconhecida';
    recordHttpRequest(request.method, rota, reply.statusCode, reply.elapsedTime / 1000);
  });
});
