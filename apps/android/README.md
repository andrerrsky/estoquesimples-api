# Estoque Simples

<p align="center">
  <img alt="App Estoque Simples" src="https://play-lh.googleusercontent.com/foVOYktWB5oFogSCjn9QSpYIlYFC2t2D3ARXhRp7ey6QSvYpPYwKrHPnnWYfaS5LwMwX=w240-h480-rw" />
</p>

## Sobre

App Android (Java) para gerenciamento de estoque.

Estoque Simples é um aplicativo que vai ajuda-lo a controlar seu estoque de forma simples, rápida e eficiente.

Com ele você pode cadastrar ou importar produtos, edita-los, verificar relatórios e gerenciar facilmente todo seu estoque.

É possível cadastrar produtos com foto, código (inclui leitor de código de barras e QRCode), nome, descrição, valor e quantidade, caso possua um arquivo com uma lista de produtos você também pode importa-los diretamente.

Você pode exportar relatórios em .pdf e texto.

Não requer acesso a internet e nenhum cadastro: o banco de dados fica armazenado em seu próprio dispositivo. Com uma conta (opcional), o estoque sincroniza com a nuvem e pode ser usado também em https://estoquesimples.com.br.

## Desenvolvimento

Este projeto fica em `apps/android` do monorepo do Estoque Simples (a API, o painel e a aplicação web estão nas pastas ao lado). Abra esta pasta no Android Studio ou rode:

```bash
./gradlew :app:assembleDebug        # APK de depuração
./gradlew :app:testDebugUnitTest    # testes unitários
```

Contexto para quem for alterar o código: [AGENTS.md](AGENTS.md). Chave de assinatura: [signing/README.md](signing/README.md).

## Acesso
*Google Play: https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples*



