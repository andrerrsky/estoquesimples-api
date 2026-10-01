import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

/**
 * Gera o par de chaves Ed25519 usado para assinar os access tokens.
 *
 * Rode `npm run keys:generate` e cole a saída nas variáveis de ambiente do
 * ambiente correspondente. Cada ambiente (homologação, produção) deve ter o
 * seu próprio par: reaproveitar a mesma chave faria um token de homologação
 * valer em produção.
 *
 * Para rotacionar: gere um par novo, publique com um JWT_KEY_ID diferente e
 * mantenha o par antigo disponível até que todos os tokens emitidos com ele
 * tenham expirado (ACCESS_TOKEN_TTL_SECONDS).
 */
async function main(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });

  const pkcs8 = await exportPKCS8(privateKey);
  const spki = await exportSPKI(publicKey);

  const inline = (pem: string) => pem.trimEnd().replace(/\n/g, '\\n');

  console.log('# Cole no .env ou nas variáveis do Railway.');
  console.log('# A chave privada é secreta: nunca versione nem compartilhe.');
  console.log(`JWT_PRIVATE_KEY="${inline(pkcs8)}"`);
  console.log(`JWT_PUBLIC_KEY="${inline(spki)}"`);
  console.log(`JWT_KEY_ID=k${Math.floor(Date.now() / 1000)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
