# Chave de assinatura do app

`key.jks` é o keystore com que o Estoque Simples
(`br.com.gameloop.estoquesimples`) é assinado para publicação na Play Store.
É a única chave mantida no repositório — o repositório é privado e de acesso
restrito. Certificados exportados, a chave `.pepk` do Play App Signing e
cópias antigas do keystore não são necessários para gerar uma versão e não
são versionados.

As senhas (do keystore e da chave) **não** ficam no repositório nem no
`build.gradle`: são informadas no Android Studio em *Build › Generate Signed
App Bundle or APK* ao gerar o `.aab`.

Perder este arquivo impede publicar atualizações com a mesma chave de upload
(seria preciso pedir a redefinição da chave ao suporte do Google Play). Mantenha
uma cópia fora do repositório, junto das senhas, num cofre de senhas.
