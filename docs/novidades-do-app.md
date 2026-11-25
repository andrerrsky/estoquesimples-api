# Novidades do app e aviso de versão nova

Duas coisas que nasceram juntas, no dia em que a versão 40 foi publicada e o
dono abriu o app esperando ser avisado — e não foi.

## O que existia (e por que ninguém era avisado)

A tela de abertura (`SplashActivity`) só decide **bloquear ou não**:
`isUpdateRequired()` compara o `versionCode` instalado com
`minRequiredVersionCode`, que vem de `/v1/config`. O bloco `app` dessa rota
nunca tinha sido preenchido — respondia `0` em tudo —, e `latestVersionCode`,
embora fosse guardado pelo app (`versao_mais_nova`), **não era lido em lugar
nenhum**. Resultado: versão nova na loja e silêncio no aplicativo.

## Aviso de versão nova

| Peça | Onde |
| --- | --- |
| Decide que há versão nova | `RemoteConfig.hasNewerVersion()` — `versionCode` instalado < `latestVersionCode` do servidor |
| Mostra | `MainActivity.updateUpdateBanner()`, faixa na tela inicial (`@id/updateBanner`) |
| Dispensa | `RemoteConfig.dismissUpdateNotice()` guarda **qual** versão foi dispensada |

Três decisões que valem o registro:

- **Quem sabe da versão nova é o servidor, não a loja.** O app não consulta a
  Play; se consultasse, avisaria antes de a versão estar liberada para todo
  mundo. Zero em `latestVersionCode` significa "não sei" e não gera aviso.
- **O corpo da faixa leva às Novidades, não à loja.** Ir direto para a Play
  pede uma decisão antes de dizer o que a pessoa ganha; o botão "Atualizar"
  continua ali, para quem já decidiu.
- **A dispensa guarda o número da versão**, não um "já fechei". Assim o aviso
  volta no lançamento seguinte sem perseguir quem preferiu ficar onde está.

Eventos: `update.notice_viewed`, `update.notice_clicked` (`target`:
`whatsnew` ou `loja`), `update.notice_dismissed`.

## Tela de novidades

Fonte única em [`packages/changelog`](../packages/changelog) — a mesma regra
da ajuda: a web importa o módulo, e `npm run changelog:sync` copia o JSON
para `apps/android/app/src/main/assets/changelog/` (a tela abre offline). O
CI roda `changelog:check`, que também recusa versão sem conteúdo: título
sozinho é pior do que versão ausente.

| Onde | O quê |
| --- | --- |
| App: menu ⋮ › Novidades do app | `WhatsNewActivity`; a versão instalada ganha selo da marca e o rótulo "você está aqui" |
| Web: `/app/novidades` | `WhatsNewPage`, mesma lista |

O número da versão é o `versionCode` do Android, porque é o que o aparelho
conhece e o que o servidor compara. O texto é para quem usa: `highlights` é
o que a pessoa ganhou, `fixes` o que estava errado.

**Ao publicar uma versão**: acrescente a entrada em `releases.json`, rode
`npm run changelog:sync` e, depois que a Play aprovar, informe o número em
**Painel › Operação › Versões do app Android**. Sem esse último passo, o
aviso não aparece para ninguém — foi exatamente o que aconteceu com a 40.

## Painel

**Operação › Versões do app Android** edita o bloco que antes só existia no
banco: versão mais nova (só avisa), versão obrigatória (bloqueia) e o recado
da tela de bloqueio. A API continua garantindo que a obrigatória nunca passe
da mais nova publicada — exigir uma versão que não existe na loja deixaria a
base sem saída. Tudo fica na auditoria (`ops.app_version_changed`).

No menu do app, "Dicas e novidades" virou **Blog** (é o que a tela é) e as
novidades do produto passaram a ter item próprio.
