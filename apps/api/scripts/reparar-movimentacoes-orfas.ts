import { sql } from 'drizzle-orm';

import { getEnv } from '../src/platform/config/env.js';
import { createDb } from '../src/platform/db/client.js';

/**
 * Encontra (e, com --apply, repara) movimentações que chegaram antes do seu
 * produto e ficaram órfãs, antes da migration 0025.
 *
 *   npm run reparar:orfas                 lista as candidatas, sem mexer em nada
 *   npm run reparar:orfas -- --apply      vincula e recalcula o saldo
 *   npm run reparar:orfas -- --workspace <id>   só uma empresa
 *
 * Como as órfãs antigas não guardam o produto pretendido, a ligação é pelo
 * nome: movimentação sem produto, enviada pela sincronização (op_id), cujo
 * nome bate com um produto ativo da mesma empresa criado depois dela. A
 * mesma assinatura também descreve um produto excluído, purgado pela limpeza
 * de lápides e recadastrado com o mesmo nome; nesse caso a adoção somaria o
 * histórico antigo ao produto novo. Por isso a lista sai antes, para
 * revisão, e nada é aplicado sem --apply.
 */

interface Candidata extends Record<string, unknown> {
  workspace_id: string;
  empresa: string;
  product_id: string;
  produto: string;
  saldo_atual: string;
  movimentacoes: number;
  soma: string;
  tipos: string;
  primeira: string;
  ultima: string;
}

const apply = process.argv.includes('--apply');
const workspaceIndex = process.argv.indexOf('--workspace');
const workspaceFiltro = workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] ?? null : null;

const handle = createDb(getEnv());
const db = handle.db;

try {
  const filtro = workspaceFiltro ? sql`AND p.workspace_id = ${workspaceFiltro}` : sql``;
  const candidatas = await db.execute<Candidata>(sql`
    SELECT p.workspace_id,
           w.name AS empresa,
           p.id AS product_id,
           p.name AS produto,
           p.quantity_cache::text AS saldo_atual,
           count(m.id)::int AS movimentacoes,
           sum(m.quantity)::text AS soma,
           string_agg(DISTINCT m.type, ', ') AS tipos,
           min(m.recorded_at)::text AS primeira,
           max(m.recorded_at)::text AS ultima
      FROM stock_movements m
      JOIN products p
        ON p.workspace_id = m.workspace_id
       AND lower(p.name) = lower(m.product_name)
       AND p.deleted_at IS NULL
       AND p.last_op_id IS NOT NULL
       AND p.change_seq > m.change_seq
      JOIN workspaces w ON w.id = p.workspace_id
     WHERE m.product_id IS NULL
       AND m.intended_product_id IS NULL
       AND m.op_id IS NOT NULL
       AND m.product_name IS NOT NULL
       ${filtro}
     GROUP BY p.workspace_id, w.name, p.id, p.name, p.quantity_cache
     ORDER BY w.name, p.name
  `);

  if (candidatas.rows.length === 0) {
    console.log('Nenhuma movimentação órfã com produto correspondente.');
  } else {
    console.log(`${candidatas.rows.length} produto(s) com movimentações órfãs do mesmo nome:\n`);
    for (const row of candidatas.rows) {
      const depois = Number(row.saldo_atual) + Number(row.soma);
      console.log(
        `- ${row.empresa} › ${row.produto} (${row.product_id})\n` +
          `    ${row.movimentacoes} movimentação(ões) [${row.tipos}] entre ${row.primeira} e ${row.ultima}, soma ${row.soma}\n` +
          `    saldo ${row.saldo_atual} → ${depois}`,
      );
    }
    console.log('');
  }

  if (!apply) {
    console.log('Nada foi alterado. Revise a lista e repita com --apply para vincular e recalcular os saldos.');
  } else if (candidatas.rows.length > 0) {
    await db.transaction(async (tx) => {
      for (const row of candidatas.rows) {
        const vinculadas = await tx.execute<{ quantity: string }>(sql`
          UPDATE stock_movements m
             SET product_id = ${row.product_id}
           WHERE m.workspace_id = ${row.workspace_id}
             AND m.product_id IS NULL
             AND m.intended_product_id IS NULL
             AND m.op_id IS NOT NULL
             AND lower(m.product_name) = lower(${row.produto})
             AND m.change_seq < (SELECT change_seq FROM products WHERE workspace_id = ${row.workspace_id} AND id = ${row.product_id})
          RETURNING m.quantity::text AS quantity
        `);
        // O gatilho de saldo só roda na inserção; o saldo passa a ser a soma de
        // tudo que aponta para o produto, que é a definição dele.
        await tx.execute(sql`
          UPDATE products p
             SET quantity_cache = coalesce((SELECT sum(m.quantity) FROM stock_movements m WHERE m.workspace_id = p.workspace_id AND m.product_id = p.id), 0)
           WHERE p.workspace_id = ${row.workspace_id} AND p.id = ${row.product_id}
        `);
        console.log(`✔ ${row.empresa} › ${row.produto}: ${vinculadas.rows.length} movimentação(ões) vinculada(s), saldo recalculado.`);
      }
    });
    console.log('\nOs aparelhos não precisam reler: o saldo deles vem das próprias movimentações. A web passa a mostrar o saldo corrigido.');
  }
} finally {
  await handle.close();
}
