# Planos, limites e por que a nuvem é grátis

Modelo em vigor desde a migration `0013_free_sync` (1º de outubro de 2026).

| | Gratuito (conta) | Equipe (assinatura, chave `basico`) |
| --- | --- | --- |
| Nuvem (`sync.nuvem`) | sim, só o proprietário | sim, toda a equipe |
| Produtos na nuvem (`produtos.sincronizados`) | até **50** vivos | sem teto |
| Pessoas na empresa (`equipe.membros`) | só o proprietário | sem teto (ajustável) |
| Aparelhos | sem teto (do próprio dono) | sem teto |
| Análise Avançada (`analise.avancada`) | não (a Versão PRO antiga libera no aparelho) | sim |
| Histórico, relatórios, importação, exportação, backup | tudo igual, no aparelho | |

Os números são linhas de `plan_features` e podem ser alterados no painel
(Planos) sem deploy. O app lê `limits`/`usage` do `GET /entitlement` e mostra
"12 de 50 produtos".

## O que custa de verdade

As fotos de produtos **nunca saem do aparelho**: a sincronização só leva
texto e números (`photo_hash` existe na tabela, mas nem é aceito no payload).
Logo o custo marginal de um usuário gratuito é só Postgres e tráfego JSON:

- um produto ≈ 1 KB com índices; 50 produtos × 10.000 empresas gratuitas ≈ 0,5 GB;
- movimentações ≈ 0,3 KB; 20/dia × 365 ≈ 2 MB/ano por empresa ativa;
- um ciclo de sincronização típico transfere poucos KB.

No Railway isso é ordem de centavos por empresa por ano. O teto de produtos
serve menos para conter custo e mais para que negócios maiores (que são os
que têm equipe) tenham motivo de assinar; por isso 50, e não 10. Se o volume
de movimentações virar problema, o próximo botão é um teto de histórico no
gratuito (retenção), não baixar o teto de produtos.

## Como o limite se comporta

- **Carga inicial**: o app declara quantos produtos vai mandar; acima do teto
  a API recusa na abertura (403 `PLAN_LIMIT_REACHED`) e confere de novo por
  lote. O app mostra o aviso e nada é enviado pela metade.
- **Envio incremental**: o lote inteiro é aceito ou recusado. Conta como novo
  só o produto que a nuvem não conhece; exclusões no mesmo lote abatem. Nunca
  recusa operação por operação, para não deixar produto meio sincronizado com
  movimentações órfãs. O app guarda tudo na fila, mostra "Sincronização
  pausada" na tela inicial e volta a tentar quando o plano ou o estoque mudar.
- **Equipe**: convidar, aceitar convite e reativar membro exigem
  `equipe.membros`. Se a assinatura acabar, os membros ficam na empresa mas
  só o proprietário sincroniza (403 para os demais, com mensagem explicando).
- Nada é apagado da nuvem nem do aparelho por limite ou por fim de assinatura.

## Onde se assina

| Canal | Provedor | Preço |
| --- | --- | --- |
| App Android | Google Play (produto `assinatura`, base plan `plano-basico`) | definido no Play Console |
| Web (`/app/plano`) | Asaas — Pix, boleto ou cartão ([billing-asaas.md](billing-asaas.md)) | `plans.web_price_monthly_cents` / `web_price_yearly_cents`, editáveis no painel (Planos); vazio = não vendido na web |

A assinatura é da empresa e vale nos dois clientes, qualquer que seja o
canal. Na web valem os mesmos limites: o teto de produtos é conferido a cada
cadastro ou importação (403 `PLAN_LIMIT_REACHED`) e, sem o recurso de equipe,
só o proprietário usa o estoque na nuvem (os demais veem a explicação em vez
do estoque).
