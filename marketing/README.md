# Materiais de divulgação

Imagens, vídeos e textos usados na Play Store, no YouTube e no Instagram.
Nada daqui entra no build (`.dockerignore`) nem dispara deploy
(`railway.json` só observa `apps/` e `packages/`).

## play-store/

Página do app na Google Play (Presença na loja › Página principal da loja).

| Arquivo | Uso |
| --- | --- |
| `icone-512.png` | ícone do app (512×512) |
| `feature-1024x500.png` | gráfico de recurso (1024×500) |
| `capturas/celular/` | 6 capturas de celular, 1080×1920 |
| `capturas/tablet-7/` | 5 capturas de tablet de 7", 1200×1920 |
| `capturas/tablet-10/` | 5 capturas de tablet de 10", 1600×2560 |
| `capturas/chromebook/` | 5 capturas de Chromebook, 1920×1080 |
| `video/estoque-simples-apresentacao-1920x1080-sem-voz.mp4` | apresentação curta (1:05) sem áudio, corte para a ficha da loja |
| `video/video-falas.txt` | falas por cena para narrar a apresentação |

## youtube/

Miniaturas (1280×720) dos vídeos no YouTube, em três variantes para testar:

- `miniaturas-promo/`: vídeo promocional ("grátis", "não bate", "2 minutos");
- `miniaturas-instalar/`: vídeo "como instalar o web app" ("iPhone sem App
  Store", "3 passos", "todos os aparelhos").

## video-promocional-2026/

Vídeo promocional de 1:40 para a Play Store e o YouTube e o vídeo "como
instalar o web app" (1920×1080, 30 fps, narração ElevenLabs).

| Arquivo | Uso |
| --- | --- |
| `roteiro-e-textos.md` | estrutura de conversão, roteiro cena a cena, títulos e descrições |
| `legendas-pt-BR.vtt` | legendas do vídeo promocional (o site serve a mesma em `apps/web/public/video/apresentacao.vtt`) |
| `como-instalar-web-app-legendas-pt-BR.vtt` | legendas do vídeo de instalação (o site usa a mesma em `apps/web/public/video/`) |
| `checklist-publicacao-v24.md` | checklist da publicação da versão 24 no Play Console |

**Os arquivos grandes não estão no Git** (o GitHub limita a 100 MB por arquivo
e cada versão ficaria para sempre no histórico):

| Arquivo | Tamanho | Onde está |
| --- | --- | --- |
| `estoque-simples-promo-1920x1080.mp4` | 47 MB | pasta `EstoqueSimples-PlayStore/video-promocional-2026` do André; a versão comprimida que o site mostra está em `apps/web/public/assets/video/apresentacao.mp4` |
| `como-instalar-web-app-1920x1080.mp4` | 26 MB | idem; a versão comprimida está em `apps/web/public/assets/video/instalar-web-app.mp4` |
| `trilha-narracao-mix.wav` | 18 MB | idem (mix da narração e trilha) |

Para versioná-los, o caminho é o Git LFS (`git lfs track "marketing/**/*.mp4"`),
que precisa do `git-lfs` instalado em cada máquina.

## instagram/

| Pasta ou arquivo | Uso |
| --- | --- |
| `feed-4x5/` | 6 posts de feed em 1080×1350 (formato recomendado) |
| `feed-quadrado/` | os mesmos 6 posts em 1080×1080 |
| `reels-stories/` | 3 anúncios curtos (15–20 s) e o reel completo (58 s), 1080×1920, sem áudio |
| `legendas-feed.txt` | legenda e hashtags de cada post |
| `falas-e-tempos.txt` | falas por cena para narrar os vídeos verticais |

Perfis: [instagram.com/estoquesimplesapp](https://www.instagram.com/estoquesimplesapp),
[facebook.com/share/1Ew1KKeopW](https://www.facebook.com/share/1Ew1KKeopW/),
[linkedin.com/company/estoque-simples](https://www.linkedin.com/company/estoque-simples/).

## Como atualizar

Gere o material novo com o mesmo nome e tamanho (as dimensões estão no nome
do arquivo), substitua aqui e abra um PR. Capturas de tela devem vir de uma
conta de demonstração, nunca de dados de cliente.
