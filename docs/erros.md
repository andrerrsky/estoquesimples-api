# Registro de erros (Admin › Erros)

Erros de produção de todas as pontas ficam numa tabela da própria API
(`error_events`, migration 0020) e aparecem no painel em **Admin › Erros**,
agrupados. Sem serviço de terceiros: a CSP da web só fala com a própria
origem e os dados ficam onde os demais já estão. Guardados por 30 dias (o
vigia `ops.watchdog` apaga os mais antigos).

| Origem | O que entra | Onde |
| --- | --- | --- |
| API | toda resposta 5xx (com a causa original, ex.: o erro do bucket) e tarefa da fila que esgotou as tentativas | `platform/http/error-handler.ts`, `platform/jobs/runner.ts` |
| Web e web app | exceção de JavaScript, promessa rejeitada sem tratamento, tela que quebrou (`RouteError`) e resposta 5xx da API | `apps/web/src/lib/error-reporter.ts` |
| App Android | queda do app (gravada no instante e enviada na abertura seguinte), erro inesperado da sincronização e resposta 5xx da API | `diagnostics/ErrorReporter.java` |

Os clientes enviam por `POST /v1/client-errors` (com ou sem login; token
vencido não impede o registro). Limites: 20 por lote, 30 por minuto por IP,
64 KB; a web manda no máximo 20 por carregamento e o mesmo erro uma vez; o
app guarda no máximo 30 na fila.

**Privacidade**: nunca entra corpo de requisição, conteúdo do estoque ou o
que foi digitado. Mensagens e pilhas passam por `scrub()` (e-mails, tokens,
JWT e `senha=`/`password=` viram `<email>`/`<oculto>`). O contexto aceita só
valores simples e descarta chaves como `senha`, `token`, `authorization`.

## Do "Erro interno" na tela até a causa

1. Erro 5xx mostra para a pessoa a mensagem com um **código curto**
   ("Erro interno… (código 7f3a9c21)"): os 8 primeiros caracteres do
   `correlationId` da resposta.
2. Em Admin › Erros, busque pelo código: aparece a ocorrência com rota,
   pessoa, empresa, versão, navegador/aparelho e a pilha.
3. O mesmo `correlationId` está no log da requisição no Railway
   (`reqId`), para ver o que mais aconteceu naquela chamada.

O agrupamento usa uma impressão digital (origem, tipo, código, mensagem sem
números e ids, primeira linha da pilha): "produto 12" e "produto 98" caem no
mesmo grupo.

## Fotos

Falha do armazenamento (bucket fora do ar, credencial recusada) não é mais
"Erro interno": a API responde 503 `IMAGES_UNAVAILABLE` com uma mensagem
clara, a web mostra o aviso junto da foto e o produto pode ser salvo sem ela.
A causa exata do bucket fica no registro.
