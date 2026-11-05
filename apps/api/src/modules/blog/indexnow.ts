import { isProduction } from '../../platform/config/env.js';
import type { AppServices } from '../../platform/http/context.js';

/**
 * IndexNow: avisa o Bing (e Yandex, Seznam, Naver) na hora em que um post é
 * publicado, mudado ou despublicado, em vez de esperar o robô passar. O
 * índice do Bing alimenta a busca do ChatGPT e do Copilot, então um post
 * novo pode aparecer nas respostas desses assistentes no mesmo dia.
 *
 * A chave não é segredo: o protocolo exige publicá-la em
 * `https://estoquesimples.com.br/<chave>.txt` (web-app.ts serve o arquivo),
 * e é ela que prova que o aviso veio do dono do domínio.
 *
 * Só em produção: homologação e testes não avisam ninguém. Falha (rede, 4xx)
 * só vai para o log — o robô passa depois de qualquer jeito.
 */

export const INDEXNOW_KEY = '7e3b9c41d8a24f6e9b05c2a1f4d86e37';
const HOST = 'estoquesimples.com.br';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

export function notifyIndexNow(services: AppServices, urls: string[]): void {
  if (!isProduction(services.env) || urls.length === 0) return;
  void (async () => {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: HOST, key: INDEXNOW_KEY, keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`, urlList: urls }),
        signal: AbortSignal.timeout(8_000),
      });
      // 200 e 202 são aceite; 4xx traz o motivo (chave não encontrada, URL de outro domínio).
      if (response.ok) services.logger?.info({ urls, status: response.status }, 'IndexNow avisado');
      else services.logger?.warn({ urls, status: response.status, body: (await response.text()).slice(0, 300) }, 'IndexNow recusou o aviso');
    } catch (error) {
      services.logger?.warn({ err: error, urls }, 'IndexNow não respondeu');
    }
  })();
}
