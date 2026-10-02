# Central de ajuda

Perguntas e respostas em linguagem simples, com busca, exibidas em três
lugares a partir de **uma fonte só**: `packages/help`.

| Arquivo | Quem lê | Onde aparece |
| --- | --- | --- |
| `faq.json` | clientes | web (`/app/ajuda` e a página pública `/ajuda`), app Android (menu **Ajuda e suporte** → `HelpActivity`) e painel (aba "Dúvidas dos clientes") |
| `faq-admin.json` | equipe | só no painel (`/admin/ajuda`, aba "Painel e atendimento") |
| `index.ts` | — | tipos, busca e leitura do texto usados pela web e pelo painel |

O app Android embute uma **cópia** de `faq.json` em
`apps/android/app/src/main/assets/help/` (a ajuda abre sem internet). Nunca
edite a cópia: altere `packages/help/faq.json` e rode `npm run help:sync`. O
CI reprova cópia defasada ou arquivo malformado (`npm run help:check`).
`faq-admin.json` descreve procedimentos internos e **não** vai para a web nem
para o app.

## Formato

```json
{
  "id": "reembolso",                 // estável: é o link (?artigo=reembolso) e o que o analytics registra
  "category": "plano",               // id de uma das `categories`
  "question": "Posso pedir reembolso?",
  "answer": ["Parágrafo.", "• item de lista", "Texto com **negrito**."],
  "keywords": ["estorno", "dinheiro de volta"],   // só para a busca
  "platforms": ["android"]           // opcional: some nas outras plataformas
}
```

O texto é de propósito mínimo (parágrafo, lista com "• " e `**negrito**`)
para render igual em React e em Android nativo. Nada de HTML.

A busca ignora acento e caixa, exige todas as palavras digitadas e ordena por
onde elas aparecem: pergunta, depois palavras-chave, depois o texto. Em
`keywords` vão os jeitos como as pessoas realmente perguntam ("dinheiro de
volta"), não sinônimos técnicos.

## Ao escrever ou alterar uma resposta

- **Confira no código.** A resposta descreve o que o sistema faz hoje, não o
  que deveria fazer. Prazo, limite e preço que são configuráveis (teto de
  produtos, tolerância de pagamento, validade de convite) não entram como
  número: a resposta aponta a tela onde o valor aparece.
- **Mudou uma regra? Mude a ajuda no mesmo commit.** Em especial: planos e
  limites, reembolso e cancelamento (têm de bater com os Termos de Uso em
  `packages/legal`), papéis da equipe e o que cada plataforma tem ou não tem.
- Linguagem de balcão: frases curtas, o nome que está escrito na tela em
  negrito, sem termos como "sync", "endpoint" ou "workspace".
- Um artigo novo do painel precisa de um `id` que não exista em `faq.json`
  (o painel busca nas duas coleções juntas).

## Eventos

`help.article_opened` (`article`) e `help.searched` (`results`), emitidos
pelo app e pela web — nunca com o texto buscado. Servem para saber quais
respostas são mais lidas e quantas buscas terminam sem resultado.
