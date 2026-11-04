# Checklist de publicação — Estoque Simples Android, versão 24

Revisão final feita em 18/10/2026 (build, lint, testes, revisão de código e
teste no emulador). Veredito: **libera com ressalvas**, todas tratadas no PR
"Android: ajustes da revisão final da versão 24". O que falta é do lado do
Play Console e de aparelho real.

## Antes de enviar o AAB

- [ ] Mesclar o PR dos ajustes e gerar o AAB a partir da `main` (Android
      Studio › Build › Generate Signed App Bundle, chave em `apps/android/signing/`).
- [ ] Conferir no AAB gerado: versionCode 24, versionName "24".

## No Play Console

- [ ] **Data Safety**: declarar o que o app coleta. Com o PR, **não** há
      Advertising ID. Declarar: e-mail e nome (conta, opcional), identificador
      de instalação (analytics e push), fotos de produtos (só com conta, vão
      para a nuvem), diagnóstico de aparelho nas solicitações de suporte
      (modelo, versão do Android e do app). Dados em trânsito cifrados; o
      usuário pode pedir exclusão.
- [ ] **URL de exclusão de conta** (exigência da Play): apontar para a web
      (estoquesimples.com.br › Conta), onde existe o botão de excluir conta.
- [ ] **Permissões**: a lista final é CAMERA, INTERNET, ACCESS_NETWORK_STATE,
      POST_NOTIFICATIONS, BILLING (+ as do Firebase/WorkManager). Não há mais
      SCHEDULE_EXACT_ALARM, então nenhuma declaração de alarme exato.
- [ ] **Vídeo da loja**: subir o vídeo no YouTube e colar o link em Presença
      na loja › Página principal da loja › Vídeo (arquivo em
      `estoque-simples-promo-1920x1080.mp4` nesta pasta, com legendas em
      `legendas-pt-BR.vtt` e textos em `roteiro-e-textos.md`).
- [ ] **Notas da versão** (sugestão): "Conta grátis com estoque na nuvem;
      fotos dos produtos sincronizadas; identidade visual da empresa (plano
      Equipe); central de ajuda e suporte pelo app; avisos de estoque baixo
      corrigidos; melhorias de desempenho e segurança."
- [ ] Lançar em **teste interno** primeiro, depois produção com **rollout
      gradual** (10–20%) e acompanhar o Android Vitals por 2–3 dias.

## Testar num aparelho real (não dá para cobrir no emulador)

- [ ] Atualizar por cima da versão que está na loja (sem desinstalar) e
      conferir que produtos e histórico continuam lá.
- [ ] Gerar o PDF de relatório num Android 11+ e abrir o arquivo em Downloads.
- [ ] Assinar o plano Equipe com uma conta de teste de licença da Play e
      conferir que a empresa é liberada.
- [ ] Receber uma resposta de suporte e um push de campanha com o app fechado.
- [ ] Enviar fotos de produtos antigas (tiradas pela câmera) num aparelho
      modesto e observar memória/tempo.

## Riscos conhecidos deixados para a próxima versão (não bloqueiam)

- Restaurar backup enquanto uma sincronização roda: os workers não esperam o
  arquivo ser trocado (pausar a sync antes de restaurar).
- Tela de Conflitos não usa a BaseActivity (sem título e sem botão voltar).
- Sair da conta descarta a fila de envio sem dizer quantos itens havia.
- A senha salva em "lembrar meus dados" fica no armazenamento cifrado do
  aparelho; o refresh token já cobre 60 dias e permitiria remover isso.
- Restos do SDK Appodeal/AppLovin no `build.gradle` (só comentários e uma
  task de símbolos nativos; não entra no app).
