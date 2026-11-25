# Sessão do app: por que ela caía sozinha

Diagnóstico de 25/11/2026, a partir da solicitação #1012 ("conta está
deslogando e não está sincronizando corretamente") — e do que a auditoria
mostrou depois: **47 quedas, em 38 contas diferentes**, numa base de cerca de
100. Quase todas no app Android.

## O mecanismo

O app guarda um *refresh token*. Quando o access token vence, ele troca o
refresh por um par novo; o antigo é marcado como usado. Se um token já usado
reaparece, a leitura clássica é roubo: quem tem o legítimo é quem usou
primeiro, então a sessão inteira é revogada.

O que faltava nessa leitura é que **a resposta pode nunca ter chegado**. No
celular isso é rotina: a rede oscila, o gateway devolve 504 (houve um
`POST /v1/auth/logout` com 504 às 17:57 do dia 25, no minuto do episódio
relatado). O aparelho então repete a requisição com o mesmo token — que o
servidor já consumiu — e levava 401 `AUTH_TOKEN_REUSE_DETECTED`. O app trata
401 como sessão encerrada, apaga as credenciais e mostra a tela de login.

A web não sofria: `/v1/auth/web/refresh` já passava `reuseGraceSeconds: 20`,
pensado para duas abas renovando juntas. A rota do app, `/v1/auth/refresh`,
não passava nada — e o padrão é zero.

## A correção (servidor, 25/11/2026)

Dentro da janela de graça (60 s no app, 20 s na web), um token já usado
**não** derruba a sessão: `AuthService.rotacionar` emite um par novo e a
resposta sai como 200, como se nada tivesse acontecido. Vale só enquanto o
substituto ainda não foi usado — se foi, o cliente recebeu a resposta e
seguiu, e aí o token velho reaparecendo não é reenvio: é a regra dura de
novo, com revogação.

Fora da janela, nada mudou: token usado de novo encerra a sessão.

Cada recuperação fica na auditoria como `user.token_refresh_recovered`, para
dar para medir quantas sessões foram salvas — e para notar se o número
disparar, que seria sinal de outra coisa.

Por ser servidor, a correção valeu para **toda a base instalada** no mesmo
deploy, sem esperar atualização de app.

## O que o cliente também via

Na mesma solicitação, "não está sincronizando corretamente" era outra coisa:
a sincronização estava em dia (cursor igual ao `change_seq` do servidor,
lag 0). O que incomodava:

- uma operação parada na fila com erro, que mantinha a frase "algumas
  alterações não foram aceitas" na tela Conta e nuvem **sem nenhuma saída** —
  agora há "Tentar enviar de novo" (que sincroniza na hora) e "Descartar
  essas alterações" (que pergunta antes e explica que o dado fica no
  aparelho);
- dois conflitos de preço no mesmo dia, resolvidos a favor do servidor,
  porque a empresa tem dois aparelhos editando os mesmos produtos. Isso é a
  regra funcionando, não defeito.
