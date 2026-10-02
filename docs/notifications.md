# Notificações (caixa de entrada + push)

Uma notificação para o cliente é **uma linha em `notifications`** (a caixa de
entrada da conta, lida pelo app e pela web) e, quando faz sentido, **um push
FCM** para os aparelhos da pessoa. A web não recebe push: ela mostra a caixa
(sino no topo, atualizado a cada minuto e ao voltar para a aba).

## API (Bearer)

| Rota | Uso |
| --- | --- |
| `GET /v1/notifications?unread=true&limit=&before=` | lista, mais recentes primeiro; `before` pagina por cursor |
| `GET /v1/notifications/unread-count` | número do sino |
| `POST /v1/notifications/:id/read` | marca uma como lida |
| `POST /v1/notifications/read-all` | marca todas |

Cada pessoa só enxerga as próprias (`user_id` da sessão); a tabela não tem
GRANT para o papel de tenant e é filtrada no serviço.

## Tipos

`NotificationType` em `apps/api/src/modules/notifications/notifications.service.ts`:

| Tipo | Quando | `data` |
| --- | --- | --- |
| `support.reply` / `support.resolved` | suporte respondeu ou encerrou a solicitação | `ticketId` |
| `billing.payment_confirmed` / `payment_overdue` / `subscription_suspended` / `subscription_ended` / `subscription_refunded` | mudança de estado da assinatura da web | `workspaceId` |
| `team.invite_accepted` | um convite seu foi aceito | `workspaceId` |
| `campaign` | campanha enviada pelo painel com "entregar na caixa" | o que a campanha definir (tela, link) |

## Acrescentar um tipo

1. Entrada nova em `NotificationType`.
2. Chamar `services.notifications.notify({ userId, type, title, body, data, workspaceId?, push? })`
   onde o fato acontece — fora de `withTenant` (a tabela é de sistema).
3. Clientes: a web mapeia tipo → ícone/destino em
   `apps/web/src/pages/NotificationsPage.tsx`; tipo desconhecido aparece com
   o visual padrão, então a API pode lançar um tipo antes dos clientes.
4. Rótulo no painel (`apps/admin/src/lib/labels.ts`) se o tipo aparecer lá.

Não coloque dado sensível em `title`/`body`: o texto também pode sair por
push e aparecer na tela bloqueada do aparelho.
