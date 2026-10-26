// API falsa para o teste do backup externo (backup-offsite-test.yml): aceita
// POST /ops/backup com o token esperado e grava o corpo em arquivo, para o
// teste conferir o que o script registraria na API de verdade.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const [port = '8787', token = 'token-de-backup-do-teste', out = 'registro.json'] = process.argv.slice(2);
createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    if (request.method !== 'POST' || request.url !== '/ops/backup' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('{}');
      return;
    }
    writeFileSync(out, body);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"message":"ok"}');
  });
}).listen(Number(port), '127.0.0.1');
