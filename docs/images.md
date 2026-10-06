# Imagens de produto

Cada produto pode ter **uma foto**. Ela é criada no aplicativo Android ou na
web, guardada num bucket S3 e aparece nos dois, pela sincronização que já
existia. Este documento descreve a arquitetura, o fluxo, os limites e a
segurança. O código está em `apps/api/src/modules/images` (API),
`apps/web/src/lib/{image.ts,product-image.tsx}` (web) e `apps/android`
(`PhotoSync`, ver o AGENTS.md do app).

## Arquitetura em uma página

```
 Android / Web                    API (Fastify)                     Railway
 ─────────────                    ─────────────                     ───────
 otimiza (WebP, ≤1280px)  ─PUT──▶ valida, reencoda se preciso ─────▶ bucket S3 (privado)
                                  grava metadados ───────────────▶ Postgres: workspace_images
 produto { photoHash } ──sync───▶ campo do produto (como nome, preço) ▶ products.photo_hash
 baixa pelo hash  ◀──GET (Bearer)── autoriza pela empresa ◀─────────── bucket
```

Decisões, e por quê:

- **Bucket do Railway (S3 compatível).** Já é do projeto: sem conta nova, sem
  credencial externa, mesma fatura. A aplicação só conhece a interface
  `ObjectStorage`; trocar para Cloudflare R2, Backblaze ou AWS é mudar variáveis
  de ambiente (`S3_*`), não código.
- **A API é a única porta do bucket** (envio e leitura passam por ela). O
  bucket é privado, sem URL pública e sem URL assinada. Motivos: nada chega ao
  armazenamento sem ser validado; a autorização é exatamente a do estoque
  (empresa, papel, plano); não é preciso configurar CORS no bucket; Android e
  web usam o mesmo caminho. O custo é a API trafegar os bytes — aceitável porque
  o arquivo é **pequeno por construção** (≤ 2 MiB aceito, tipicamente
  100–250 KB depois da otimização no cliente). Se o volume algum dia justificar,
  o caminho de evolução é URL assinada de PUT/GET emitida por esta mesma API,
  sem mudar o modelo de dados.
- **A imagem é identificada pelo SHA-256 do conteúdo guardado** (`hash`), por
  empresa. Isso dá, sem código extra: idempotência (reenviar o mesmo arquivo
  devolve a mesma imagem); sem duplicatas (dois produtos com a mesma foto = um
  objeto); **cache perfeito** (o conteúdo de um hash nunca muda, então
  `Cache-Control: immutable` por um ano; trocar a foto troca o hash e, com ele,
  a "URL" — nunca aparece versão velha).
- **O vínculo é um campo do produto** (`products.photo_hash`, coluna que já
  existia desde a migration 0004). Sincroniza como nome ou preço: mesmas
  regras de versão (`rev`), mesclagem por campo e conflito (o servidor
  prevalece num conflito de foto), exclusão e restauração. Não há fila nem
  protocolo paralelo.
- **Sem binário no banco.** `workspace_images` guarda só metadados e posse.

## Modelo de dados (migration 0016)

`workspace_images (workspace_id, hash, source_hash, content_type, bytes, width,
height, created_by, created_at, orphaned_at)`, única por `(workspace_id, hash)`,
com RLS como as demais tabelas de empresa. `products.photo_hash` aceita só o
formato de um SHA-256 (CHECK); que a imagem exista na empresa é conferido pela
API (uma FK exigiria a imagem antes do produto e quebraria a ordem de chegada
das operações de sincronização).

A cota é o recurso de plano `imagens.armazenamento_mb` em `plan_features`
(gratuito 100, Equipe 5000; `NULL` = sem limite; editável no painel em Planos).

Chave do objeto: `workspaces/<workspaceId>/images/<hash>.webp` — sempre
montada pelo servidor, com validação do formato antes de qualquer acesso.

## API

| Rota | Quem | O que faz |
| --- | --- | --- |
| `PUT /v1/workspaces/:id/images` | `produtos.criar` ou `produtos.editar` | corpo = bytes do arquivo (`image/webp`, `image/jpeg`, `image/png`); devolve `{hash, contentType, bytes, width, height, created}` (201 nova, 200 já existente) |
| `GET /v1/workspaces/:id/images/:hash` | `produtos.ver` | os bytes; `ETag: "<hash>"`, `Cache-Control: private, max-age=31536000, immutable`; 304 com `If-None-Match` sem tocar no bucket |
| `photoHash` em produtos | — | web: `POST/PATCH /products` (`photoHash`; `null` remove). Sincronização: campo `photoHash` do produto no `push` e no `pull` |

Ambas passam pela guarda de plano da nuvem (`assertCloudAccess`). Erros:
`415 IMAGE_UNSUPPORTED_TYPE`, `422 IMAGE_INVALID`, `413 PAYLOAD_TOO_LARGE`,
`403 PLAN_LIMIT_REACHED` (cota; `extra.limit`/`extra.current` em MB),
`403 MISSING_PERMISSION`, `503 IMAGES_UNAVAILABLE` (sem bucket configurado).

No `push`, `photoHash` **ausente** = "não mexi na foto" (aparelhos antigos
nunca o enviam e não apagam a foto sem querer), `null` = remover, hash = definir.
Uma foto só vale se a imagem já foi enviada para a empresa: no `push`, um
hash desconhecido é ignorado (o resto do produto é aplicado — travar o estoque
por causa de uma foto seria o contrário do desejado); na API da web é erro
422 claro.

## Fluxo de envio e sincronização

1. **Otimizar no cliente.** Web: `createImageBitmap` com a orientação do EXIF,
   canvas, WebP (JPEG onde o navegador não gera WebP), lado maior 1280 px, alvo
   ~250 KB, sem metadados. Android: mesmo critério (WebP lossy, 1280 px).
   Arquivo claramente inválido (tipo, 25 MB) é recusado antes de qualquer envio.
2. **Enviar** (`PUT`) e receber o `hash`. Repetir é seguro.
3. **Apontar o produto** para o hash (web: no mesmo salvar do produto, depois
   do envio; Android: operação de edição do produto na fila de sincronização).
4. **Outros clientes** recebem `photoHash` no `pull`/lista e baixam a imagem
   pelo hash, uma vez (o navegador/aparelho guarda por hash).

**Offline (Android).** A foto fica no aparelho; o envio e a operação de edição
só acontecem quando a sincronização é possível. Falha transitória
(rede, 429, 503, cota) mantém a foto local e tenta no próximo ciclo; erro
permanente do arquivo (415/422/413) não é repetido para sempre. Foto nunca
bloqueia a sincronização do estoque.

**Múltiplos aparelhos / conflito.** Edição de foto concorrente segue a mesclagem
por campo: se dois aparelhos trocam a foto do mesmo produto, a do servidor
prevalece e a perdedora vira lixo coletável. Trocar a foto num aparelho e outro
campo em outro se mescla sem conflito.

**Substituir e remover.** Trocar muda o `photoHash`; remover grava `null`. A
imagem antiga continua no bucket até a coleta de lixo.

## Coleta de lixo

Tarefa `images.gc` (1×/dia). Em duas etapas, para nunca apagar o que um
aparelho offline ainda vai apontar: a imagem sem produto e com mais de 1 dia é
**marcada** (`orphaned_at`); só é apagada (objeto e linha) se continuar sem
referência depois de `IMAGE_GC_GRACE_DAYS` (7). Produto excluído conta como
referência até a limpeza definitiva do produto. Voltar a usar a imagem limpa a
marca. O objeto é apagado antes da linha: falha no bucket deixa a linha e a
próxima rodada repete. Resta um caso raro e inofensivo: objeto sem linha (se o
banco falhar logo depois da gravação do objeto); o reenvio o reaproveita pela
chave.

## Segurança

A API nunca confia no cliente:

- **Tipo real pelos bytes** (assinatura de WebP, JPEG ou PNG; SVG, GIF, HEIC e
  qualquer outra coisa são recusados). O `Content-Type` declarado precisa
  concordar com o conteúdo (MIME spoofing = 415). Não há nome de arquivo nem
  extensão para confiar: o corpo é o arquivo bruto, sem multipart.
- **Decodificação de verdade** (sharp/libvips): arquivo truncado ou com
  cabeçalho forjado = 422; animação recusada; mínimo 16 px; máximo 8000 px de
  lado e 36 MP decodificados (protege memória contra bombas de descompressão).
- **Normalização.** Tudo que não é WebP já limpo e ≤ 1280 px é reescrito como
  WebP (orientação aplicada, metadados/EXIF/localização descartados, ≤ 1 MiB).
  Conteúdo escondido no fim de um arquivo "válido" (polyglot) não sobrevive à
  reescrita (há teste).
- **Nunca executável.** O bucket é privado e só a API serve: `Content-Type`
  fixo da imagem guardada, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin`.
- **Isolamento.** Toda consulta inclui o `workspaceId` autenticado e a posse
  (`workspace_images`, com RLS); um hash de outra empresa é "não encontrado". O
  mesmo arquivo em duas empresas são dois objetos independentes. Não se
  aponta um produto para imagem de outra empresa (422 na web; ignorado na
  sincronização). Papel e plano são os do estoque (consulta baixa e vê; só quem
  cria/edita envia).
- **Limites.** Corpo máximo `IMAGE_MAX_UPLOAD_BYTES` (2 MiB), cota por plano,
  limite de requisições por rota.

## Limites (padrão)

| O quê | Valor |
| --- | --- |
| Formatos aceitos | WebP, JPEG, PNG |
| Envio máximo | 2 MiB (`IMAGE_MAX_UPLOAD_BYTES`) |
| Lado maior guardado | 1280 px (`IMAGE_MAX_EDGE`) |
| Tamanho guardado | ≤ 1 MiB; alvo do cliente ~250 KB |
| Entrada máxima antes de reduzir | 8000 px de lado, 36 MP |
| Cota por empresa | 100 MB (gratuito), 5.000 MB (Equipe) — `plan_features` |
| Carência da coleta de lixo | 7 dias (`IMAGE_GC_GRACE_DAYS`) |

AVIF foi avaliado e **não** adotado: o Android só gera AVIF a partir da API 34
(o app suporta desde a 24) e o ganho sobre WebP não compensa a complexidade.

## Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `S3_BUCKET` | nome do bucket. Sem ela, em produção o envio de imagens fica desligado (503) e o resto funciona; em dev/teste grava em disco (`IMAGE_FS_DIR`, padrão `.data/images`) |
| `S3_ENDPOINT` | endpoint S3 (Railway: `https://t3.storageapi.dev`) |
| `S3_REGION` | `auto` no Railway |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | credenciais do bucket |
| `S3_FORCE_PATH_STYLE` | `true` só para MinIO e similares (o Railway usa o estilo padrão, virtual-host) |
| `IMAGE_MAX_UPLOAD_BYTES`, `IMAGE_MAX_EDGE`, `IMAGE_GC_GRACE_DAYS` | limites acima |

## Configuração em produção (Railway)

Já feita no projeto `estoquesimples-api`, ambiente `production`:

```bash
railway bucket create estoquesimples-imagens --region iad    # US East
railway bucket credentials --bucket estoquesimples-imagens --json   # nome real, endpoint, chaves
railway variables --service estoquesimples-api --set S3_BUCKET=<bucketName> \
  --set S3_ENDPOINT=<endpoint> --set S3_REGION=auto \
  --set S3_ACCESS_KEY_ID=<accessKeyId> --set S3_SECRET_ACCESS_KEY=<secretAccessKey>
```

O nome real do bucket tem um sufixo gerado pelo Railway (`bucketName` na
resposta de `credentials`). **Staging** (projeto separado) precisa do próprio
bucket e das próprias variáveis. Backups: o bucket não entra no backup do
Postgres; as imagens são recuperáveis dos aparelhos enquanto a foto existir
neles, mas considere uma cópia periódica do bucket se as fotos virarem críticas.

### Como validar

1. `railway bucket info --bucket estoquesimples-imagens` mostra objetos e bytes.
2. Na web, cadastre um produto com foto: a miniatura aparece na lista e o
   contador de objetos do bucket sobe em 1.
3. `GET https://api.estoquesimples.com.br/ready` continua `ready` (o bucket
   não é checado no `/ready`; um bucket mal configurado aparece como 503
   `IMAGES_UNAVAILABLE`/erro nos logs ao enviar).

## Custo

O bucket do Railway cobra por armazenamento (ordem de US$ 0,015 por GB-mês na
data desta implementação — confira a página de preços do Railway). Uma foto
otimizada tem ~100–250 KB: 10.000 fotos ≈ 1–2,5 GB ≈ centavos por mês. A cota
por plano limita o pior caso.
