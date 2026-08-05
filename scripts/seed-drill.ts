import { randomUUID } from 'node:crypto';

import { getEnv } from '../src/platform/config/env.js';
import { createDb } from '../src/platform/db/client.js';
import {
  products,
  stockMovements,
  users,
  workspaceMembers,
  workspaces,
} from '../src/platform/db/schema/index.js';

/**
 * Dados mínimos para o exercício de restauração.
 *
 * Um dump de banco vazio restaura sem erro e não prova nada. O exercício só
 * tem valor se houver conteúdo nas tabelas que importam — as mesmas que o
 * verificador exige não estarem vazias depois de restaurar.
 */
async function main(): Promise<void> {
  const handle = createDb(getEnv());

  try {
    const [usuario] = await handle.db
      .insert(users)
      .values({
        email: `exercicio.${randomUUID()}@exemplo.com.br`,
        name: 'Conta de exercício',
        // Hash descartável: este banco existe por poucos minutos dentro do CI.
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$ZXhlcmNpY2lv$exercicio',
      })
      .returning({ id: users.id });

    if (!usuario) throw new Error('não foi possível criar o usuário do exercício');

    const [empresa] = await handle.db
      .insert(workspaces)
      .values({ name: 'Empresa de exercício', ownerUserId: usuario.id })
      .returning({ id: workspaces.id });

    if (!empresa) throw new Error('não foi possível criar a empresa do exercício');

    await handle.db.insert(workspaceMembers).values({
      workspaceId: empresa.id,
      userId: usuario.id,
      roleKey: 'proprietario',
      status: 'active',
    });

    const [produto] = await handle.db
      .insert(products)
      .values({
        id: randomUUID(),
        workspaceId: empresa.id,
        name: 'Produto de exercício',
        quantityCache: '10',
        unitValue: '9.90',
        changeSeq: 1,
      })
      .returning({ id: products.id });

    if (!produto) throw new Error('não foi possível criar o produto do exercício');

    await handle.db.insert(stockMovements).values({
      id: randomUUID(),
      workspaceId: empresa.id,
      productId: produto.id,
      type: 'entrada',
      quantity: '10',
      occurredAt: new Date(),
      changeSeq: 2,
    });

    console.log('dados de exercício criados');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('falha ao semear o exercício:', error instanceof Error ? error.message : error);
  process.exit(1);
});
