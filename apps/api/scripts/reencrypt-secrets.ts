import { sql } from 'drizzle-orm';

import { getEnv } from '../src/platform/config/env.js';
import { ephemeralDevPurchaseTokenKey, keyringFromEnv, purchaseTokenAad, PurchaseTokenCipher, settingAad } from '../src/platform/crypto/purchase-token.js';
import { createDb } from '../src/platform/db/client.js';

/**
 * Recifra com a chave ativa tudo o que está guardado com outra chave ou no
 * formato antigo (v0/v1). Passo 3 da rotação descrita em docs/seguranca.md.
 *
 *   npm run secrets:reencrypt            # mostra quantos valores mudariam
 *   npm run secrets:reencrypt -- --apply # grava
 *
 * Idempotente: rodar de novo só confirma que não sobrou nada. Em produção,
 * rode via `railway run` no serviço da API, com o chaveiro novo já configurado.
 */
interface Target {
  label: string;
  select: ReturnType<typeof sql>;
  update: (id: string, value: string) => ReturnType<typeof sql>;
  aad: (row: Record<string, unknown>) => string | undefined;
  column: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const env = getEnv();
  const cipher = new PurchaseTokenCipher(keyringFromEnv(env, ephemeralDevPurchaseTokenKey()));
  const legacyReader = new PurchaseTokenCipher({ ...keyringFromEnv(env, ephemeralDevPurchaseTokenKey()), allowLegacy: true });
  const { db, close } = createDb(env);

  const targets: Target[] = [
    {
      label: 'admin_settings',
      column: 'value_enc',
      select: sql`SELECT key AS id, key, value_enc FROM admin_settings`,
      update: (id, value) => sql`UPDATE admin_settings SET value_enc = ${value} WHERE key = ${id}`,
      aad: (row) => settingAad(String(row['key'])),
    },
    {
      label: 'platform_admins.totp_secret',
      column: 'totp_secret',
      select: sql`SELECT id::text AS id, totp_secret FROM platform_admins WHERE totp_secret IS NOT NULL`,
      update: (id, value) => sql`UPDATE platform_admins SET totp_secret = ${value} WHERE id = ${id}::uuid`,
      aad: (row) => `platform_admins.totp_secret:${String(row['id'])}`,
    },
    {
      label: 'subscriptions.purchase_token_enc',
      column: 'purchase_token_enc',
      select: sql`SELECT id::text AS id, purchase_token_hash, purchase_token_enc FROM subscriptions WHERE purchase_token_enc IS NOT NULL`,
      update: (id, value) => sql`UPDATE subscriptions SET purchase_token_enc = ${value} WHERE id = ${id}::uuid`,
      aad: (row) => (row['purchase_token_hash'] ? purchaseTokenAad(String(row['purchase_token_hash'])) : undefined),
    },
    {
      label: 'subscriptions.linked_purchase_token_enc',
      column: 'linked_purchase_token_enc',
      select: sql`SELECT id::text AS id, linked_purchase_token_hash AS purchase_token_hash, linked_purchase_token_enc FROM subscriptions WHERE linked_purchase_token_enc IS NOT NULL`,
      update: (id, value) => sql`UPDATE subscriptions SET linked_purchase_token_enc = ${value} WHERE id = ${id}::uuid`,
      aad: (row) => (row['purchase_token_hash'] ? purchaseTokenAad(String(row['purchase_token_hash'])) : undefined),
    },
    {
      label: 'subscription_events.purchase_token_enc',
      column: 'purchase_token_enc',
      select: sql`SELECT id::text AS id, purchase_token_hash, purchase_token_enc FROM subscription_events WHERE purchase_token_enc IS NOT NULL`,
      update: (id, value) => sql`UPDATE subscription_events SET purchase_token_enc = ${value} WHERE id = ${id}`,
      aad: (row) => (row['purchase_token_hash'] ? purchaseTokenAad(String(row['purchase_token_hash'])) : undefined),
    },
  ];

  let changed = 0;
  let failed = 0;
  for (const target of targets) {
    const rows = (await db.execute<Record<string, unknown>>(target.select)).rows;
    let count = 0;
    for (const row of rows) {
      const blob = String(row[target.column]);
      if (!cipher.needsReencrypt(blob)) continue;
      try {
        const aad = target.aad(row);
        // Recifrar exige poder ler o formato antigo, mesmo com SECRETS_ALLOW_LEGACY=false.
        const plain = legacyReader.decrypt(blob, aad);
        if (apply) await db.execute(target.update(String(row['id']), cipher.encrypt(plain, aad)));
        count += 1;
      } catch (error) {
        failed += 1;
        console.error(`  ${target.label} ${String(row['id'])}: não decifrou (${(error as Error).message})`);
      }
    }
    console.log(`${target.label}: ${count} de ${rows.length} ${apply ? 'recifrados' : 'a recifrar'}`);
    changed += count;
  }
  console.log(apply ? `Pronto: ${changed} valores recifrados.` : `Simulação: ${changed} valores mudariam. Rode com --apply para gravar.`);
  await close();
  if (failed > 0) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
