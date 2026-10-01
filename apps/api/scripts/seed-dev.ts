import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getEnv } from '../src/platform/config/env.js';
import { createDb } from '../src/platform/db/client.js';
import { hashPassword } from '../src/platform/auth/password.js';

/**
 * Dados de demonstração para desenvolvimento local do painel.
 *
 *   npm run seed:dev
 *
 * Cria contas, empresas, assinaturas em vários estados, eventos de uso ao
 * longo de 45 dias e auditoria, para que o painel tenha o que mostrar.
 * Recusa rodar fora de development: nunca deve tocar staging ou produção.
 */
const PASSWORD = 'SenhaForte#2026';

const NAMES = [
  'Ana Lima', 'Bruno Costa', 'Carla Souza', 'Diego Martins', 'Elisa Rocha', 'Fábio Nunes',
  'Gabriela Pires', 'Henrique Alves', 'Isabela Freitas', 'João Pedro', 'Karina Melo', 'Lucas Ramos',
  'Mariana Dias', 'Nicolas Braga', 'Olívia Castro', 'Paulo Reis', 'Quésia Lopes', 'Rafael Teixeira',
];
const COMPANIES = [
  'Mercearia da Ana', 'Auto Peças Costa', 'Papelaria Souza', 'Distribuidora Martins', 'Farmácia Rocha',
  'Bar do Fábio', 'Ateliê Gabi', 'Pet Shop Alves', 'Loja da Isa', 'Ferragens JP', 'Doceria Melo', 'Lucas Bikes',
];
const SCREENS = ['MainActivity', 'AddActivity', 'HistoryActivity', 'ReportsActivity', 'ImportActivity', 'EditActivity', 'AnalyticsActivity', 'SubscriptionActivity'];
const APP_EVENTS = ['product.created', 'product.updated', 'movement.created', 'movement.created', 'movement.created', 'search.performed', 'report.generated', 'barcode.scanned', 'low_stock.filter_used', 'export.completed'];

function daysAgo(days: number, hour = 12): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  return date;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

async function main(): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV !== 'development') {
    console.error('seed:dev só roda com NODE_ENV=development');
    process.exit(1);
  }
  const handle = createDb(env);
  const { db } = handle;

  try {
    const passwordHash = await hashPassword(PASSWORD);
    const users: Array<{ id: string; email: string; createdAt: Date; installId: string; deviceId: string }> = [];

    for (let i = 0; i < NAMES.length; i += 1) {
      const name = NAMES[i] as string;
      const email = `${name.toLowerCase().replace(/\s+/g, '.').normalize('NFD').replace(/[^a-z.]/g, '')}@exemplo.com.br`;
      const createdAt = daysAgo(Math.floor(Math.random() * 45), 9 + Math.floor(Math.random() * 10));
      const verified = i % 5 !== 3;
      const status = i === 14 ? 'suspended' : i === 16 ? 'pending_deletion' : 'active';
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, name, password_hash, email_verified_at, status, deletion_requested_at, created_at, updated_at)
        VALUES (${email}, ${name}, ${passwordHash}, ${verified ? createdAt : null}, ${status},
                ${status === 'pending_deletion' ? daysAgo(2) : null}, ${createdAt}, ${createdAt})
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      const id = rows.rows[0]?.id;
      if (!id) continue;
      const installId = randomUUID();
      const device = await db.execute<{ id: string }>(sql`
        INSERT INTO devices (user_id, install_id, platform, model, os_version, app_version_code, app_version_name, sync_protocol_version, last_seen_at, created_at)
        VALUES (${id}, ${installId}, 'android', ${pick(['Samsung SM-A155M', 'Motorola moto g54', 'Xiaomi Redmi Note 13', 'Samsung SM-S911B', 'Motorola moto e22'])},
                ${pick(['Android 13', 'Android 14', 'Android 12'])}, ${pick([22, 23, 24, 24, 24])}, ${pick(['22', '23', '24', '24', '24'])}, 1,
                ${daysAgo(Math.floor(Math.random() * 6))}, ${createdAt})
        RETURNING id
      `);
      const deviceId = device.rows[0]?.id as string;
      users.push({ id, email, createdAt, installId, deviceId });

      await db.execute(sql`
        INSERT INTO sessions (user_id, device_id, user_agent, ip_address, created_at, last_used_at, expires_at)
        VALUES (${id}, ${deviceId}, 'EstoqueSimples/24 (Android)', ${`177.${Math.floor(Math.random() * 200)}.10.${Math.floor(Math.random() * 250)}`}::inet,
                ${createdAt}, ${daysAgo(Math.floor(Math.random() * 5))}, ${new Date(Date.now() + 40 * 86_400_000)})
      `);
      await db.execute(sql`
        INSERT INTO audit_log (actor_user_id, actor_device_id, action, entity_type, entity_id, created_at)
        VALUES (${id}, ${deviceId}, 'user.registered', 'user', ${id}, ${createdAt})
      `);
      await db.execute(sql`
        INSERT INTO analytics_events (name, occurred_at, user_id, device_id, install_id, platform, source, properties)
        VALUES ('user.registered', ${createdAt}, ${id}, ${deviceId}, ${installId}, 'server', 'server', '{"origin":"direto"}')
      `);
    }

    // Empresas: os 12 primeiros usuários são donos; alguns convidam colegas.
    const workspaces: Array<{ id: string; ownerId: string; createdAt: Date }> = [];
    for (let i = 0; i < COMPANIES.length; i += 1) {
      const owner = users[i];
      if (!owner) continue;
      const createdAt = new Date(owner.createdAt.getTime() + 3_600_000);
      const seeded = i % 4 !== 3;
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO workspaces (name, owner_user_id, seeded_at, change_seq, created_at, updated_at)
        VALUES (${COMPANIES[i]}, ${owner.id}, ${seeded ? createdAt : null}, ${seeded ? 40 + i * 17 : 0}, ${createdAt}, ${createdAt})
        RETURNING id
      `);
      const id = rows.rows[0]?.id as string;
      workspaces.push({ id, ownerId: owner.id, createdAt });
      await db.execute(sql`INSERT INTO workspace_members (workspace_id, user_id, role_key, status, joined_at) VALUES (${id}, ${owner.id}, 'proprietario', 'active', ${createdAt})`);
      await db.execute(sql`INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES (${id}, ${owner.id}, 'workspace.created', 'workspace', ${id}, ${JSON.stringify({ name: COMPANIES[i] })}::jsonb, ${createdAt})`);
      await db.execute(sql`INSERT INTO analytics_events (name, occurred_at, user_id, workspace_id, platform, source) VALUES ('workspace.created', ${createdAt}, ${owner.id}, ${id}, 'server', 'server')`);

      // membros convidados
      const member = users[12 + (i % 6)];
      if (member && i % 2 === 0) {
        await db.execute(sql`INSERT INTO workspace_members (workspace_id, user_id, role_key, status, invited_by, joined_at) VALUES (${id}, ${member.id}, ${pick(['operador', 'gerente', 'consulta'])}, 'active', ${owner.id}, ${daysAgo(Math.floor(Math.random() * 20))}) ON CONFLICT DO NOTHING`);
      }

      if (seeded) {
        await db.execute(sql`INSERT INTO initial_uploads (workspace_id, created_by, device_id, declared_products, declared_movements, received_products, received_movements, status, created_at, completed_at) VALUES (${id}, ${owner.id}, ${owner.deviceId}, ${30 + i * 7}, ${120 + i * 40}, ${30 + i * 7}, ${120 + i * 40}, 'concluida', ${createdAt}, ${new Date(createdAt.getTime() + 120_000)})`);
        await db.execute(sql`INSERT INTO analytics_events (name, occurred_at, user_id, workspace_id, platform, source, properties) VALUES ('sync.initial_upload_completed', ${new Date(createdAt.getTime() + 120_000)}, ${owner.id}, ${id}, 'server', 'server', ${JSON.stringify({ products: 30 + i * 7, movements: 120 + i * 40 })}::jsonb)`);
        await db.execute(sql`INSERT INTO sync_cursors (workspace_id, device_id, user_id, cursor, last_push_at, last_pull_at, updated_at) VALUES (${id}, ${owner.deviceId}, ${owner.id}, ${40 + i * 17 - (i % 3) * 5}, ${daysAgo(i % 4)}, ${daysAgo(i % 4)}, ${daysAgo(i % 4)})`);

        // produtos e movimentações
        const units = ['un', 'kg', 'cx', 'L'];
        for (let p = 0; p < 12 + i; p += 1) {
          const productId = randomUUID();
          const minStock = Math.floor(Math.random() * 10);
          const qty = Math.random() < 0.25 ? minStock - 1 : minStock + Math.floor(Math.random() * 40);
          await db.execute(sql`
            INSERT INTO products (id, workspace_id, name, quantity_cache, min_stock, unit_value, unit, category, sku, rev, change_seq, created_at, updated_at)
            VALUES (${productId}, ${id}, ${`Produto ${p + 1} ${pick(['Azul', 'Grande', 'Premium', 'Kit', 'Refil', 'Pro'])}`}, ${Math.max(0, qty)}, ${minStock},
                    ${(Math.random() * 120 + 2).toFixed(2)}, ${pick(units)}, ${pick(['Bebidas', 'Limpeza', 'Peças', 'Papelaria', 'Alimentos', null])},
                    ${`SKU-${i}${p}`}, 1, ${p + 1}, ${createdAt}, ${daysAgo(Math.floor(Math.random() * 10))})
          `);
          for (let m = 0; m < 3; m += 1) {
            const type = pick(['entrada', 'saida', 'saida', 'ajuste']);
            const quantity = type === 'entrada' ? 5 + Math.floor(Math.random() * 20) : type === 'saida' ? -(1 + Math.floor(Math.random() * 6)) : Math.floor(Math.random() * 7) - 3 || 1;
            await db.execute(sql`
              INSERT INTO stock_movements (id, workspace_id, product_id, product_name, type, quantity, occurred_at, recorded_at, created_by, device_id, change_seq)
              VALUES (${randomUUID()}, ${id}, ${productId}, ${`Produto ${p + 1}`}, ${type}, ${quantity}, ${daysAgo(Math.floor(Math.random() * 30))}, ${daysAgo(Math.floor(Math.random() * 30))}, ${owner.id}, ${owner.deviceId}, ${100 + p * 3 + m})
            `);
          }
        }
        if (i % 5 === 1) {
          await db.execute(sql`INSERT INTO conflict_log (workspace_id, entity_type, entity_id, field, kind, status, base_value, kept_value, discarded_value, created_by, created_at) VALUES (${id}, 'produto', ${randomUUID()}, 'name', 'campo', 'pendente', '"Produto 3"', '"Produto 3 Azul"', '"Produto 3 Grande"', ${owner.id}, ${daysAgo(9)})`);
        }
      }
    }

    // Assinaturas em vários estados
    const states = ['ativa', 'ativa', 'ativa', 'carencia', 'cancelada_mas_ativa', 'suspensa', 'expirada', 'ativa', 'reembolsada'];
    for (let i = 0; i < states.length; i += 1) {
      const ws = workspaces[i];
      if (!ws) continue;
      const state = states[i] as string;
      const startedAt = new Date(ws.createdAt.getTime() + 2 * 86_400_000);
      const periodEnd = state === 'expirada' ? daysAgo(5) : new Date(Date.now() + (3 + i * 4) * 86_400_000);
      const tokenHash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO subscriptions (workspace_id, purchaser_user_id, plan_key, purchase_token_hash, purchase_token_enc, google_product_id, google_base_plan_id, state, auto_renewing, acknowledged, started_at, current_period_end, grace_until, canceled_at, latest_notification_type, last_verified_at, raw, created_at, updated_at)
        VALUES (${ws.id}, ${ws.ownerId}, 'basico', ${tokenHash}, 'v1:seed', 'assinatura', 'plano-basico', ${state},
                ${state === 'ativa' || state === 'carencia'}, true, ${startedAt}, ${periodEnd},
                ${state === 'carencia' ? new Date(Date.now() + 5 * 86_400_000) : null},
                ${state === 'cancelada_mas_ativa' ? daysAgo(3) : null},
                ${state === 'ativa' ? 2 : state === 'carencia' ? 6 : state === 'suspensa' ? 5 : state === 'cancelada_mas_ativa' ? 3 : state === 'expirada' ? 13 : 12},
                ${i === 2 ? daysAgo(3) : daysAgo(0, 6)}, '{"subscriptionState":"SUBSCRIPTION_STATE_ACTIVE","lineItems":[{"productId":"assinatura","offerDetails":{"basePlanId":"plano-basico"}}]}'::jsonb,
                ${startedAt}, ${state === 'expirada' ? daysAgo(5) : daysAgo(Math.floor(Math.random() * 3))})
        RETURNING id
      `);
      const subId = rows.rows[0]?.id as string;
      await db.execute(sql`INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES (${ws.id}, ${ws.ownerId}, 'subscription.linked', 'subscription', ${subId}, ${JSON.stringify({ planKey: 'basico', state: 'ativa', productId: 'assinatura' })}::jsonb, ${startedAt})`);
      await db.execute(sql`INSERT INTO analytics_events (name, occurred_at, user_id, workspace_id, platform, source, properties) VALUES ('subscription.linked', ${startedAt}, ${ws.ownerId}, ${ws.id}, 'server', 'server', '{"planKey":"basico","state":"ativa"}')`);
      if (state !== 'ativa') {
        const changedAt = daysAgo(Math.floor(Math.random() * 6) + 1);
        await db.execute(sql`INSERT INTO audit_log (workspace_id, action, entity_type, entity_id, metadata, created_at) VALUES (${ws.id}, 'subscription.state_changed', 'subscription', ${subId}, ${JSON.stringify({ from: 'ativa', to: state, notificationType: 3 })}::jsonb, ${changedAt})`);
        await db.execute(sql`INSERT INTO analytics_events (name, occurred_at, user_id, workspace_id, platform, source, properties) VALUES ('subscription.state_changed', ${changedAt}, ${ws.ownerId}, ${ws.id}, 'server', 'server', ${JSON.stringify({ from: 'ativa', to: state })}::jsonb)`);
      }
      for (let e = 0; e < 3; e += 1) {
        await db.execute(sql`INSERT INTO subscription_events (notification_id, notification_type, purchase_token_hash, subscription_id, payload, received_at, processed_at, process_error)
          VALUES (${randomUUID()}, ${pick([2, 2, 4, 3, 6])}, ${tokenHash}, ${subId}, '{"version":"1.0"}', ${daysAgo(e * 7 + 1)}, ${e === 0 && i === 5 ? null : daysAgo(e * 7 + 1)}, ${e === 0 && i === 5 ? 'Falha ao autenticar na API do Google Play.' : null})`);
      }
    }

    // Eventos de uso do app ao longo de 45 dias
    let total = 0;
    for (const user of users) {
      const activityLevel = Math.random();
      for (let day = 44; day >= 0; day -= 1) {
        if (daysAgo(day) < user.createdAt) continue;
        if (Math.random() > activityLevel * 0.9 + 0.05) continue;
        const ws = workspaces.find((item) => item.ownerId === user.id) ?? pick(workspaces);
        const sessionKey = randomUUID().slice(0, 8);
        const base = daysAgo(day, 8 + Math.floor(Math.random() * 11));
        const perDay = 2 + Math.floor(Math.random() * 8);
        const events: Array<[string, Record<string, unknown>]> = [['app.opened', { coldStart: true }]];
        for (let n = 0; n < perDay; n += 1) {
          if (Math.random() < 0.5) events.push(['screen.viewed', { screen: pick(SCREENS) }]);
          else {
            const name = pick(APP_EVENTS);
            events.push([name, name === 'movement.created' ? { type: pick(['entrada', 'saida', 'ajuste']) } : name === 'report.generated' ? { format: pick(['pdf', 'texto']) } : {}]);
          }
        }
        if (Math.random() < 0.6 && ws) events.push(['sync.pushed', { operations: perDay, applied: perDay, rejected: 0, conflicts: 0 }]);
        for (let n = 0; n < events.length; n += 1) {
          const [name, props] = events[n] as [string, Record<string, unknown>];
          const isServer = name.startsWith('sync.');
          await db.execute(sql`
            INSERT INTO analytics_events (client_event_id, name, occurred_at, user_id, workspace_id, device_id, install_id, platform, app_version_code, session_key, source, properties)
            VALUES (${isServer ? null : randomUUID()}, ${name}, ${new Date(base.getTime() + n * 45_000)}, ${user.id}, ${ws?.id ?? null}, ${user.deviceId}, ${user.installId},
                    ${isServer ? 'server' : 'android'}, ${isServer ? null : 24}, ${sessionKey}, ${isServer ? 'server' : 'app'}, ${JSON.stringify(props)}::jsonb)
          `);
          total += 1;
        }
        if (Math.random() < 0.4) {
          await db.execute(sql`INSERT INTO audit_log (actor_user_id, actor_device_id, action, entity_type, entity_id, created_at) VALUES (${user.id}, ${user.deviceId}, 'user.logged_in', 'user', ${user.id}, ${base})`);
        }
      }
    }
    // algumas falhas de login
    const victim = users[7];
    if (victim) {
      for (let n = 0; n < 6; n += 1) {
        await db.execute(sql`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES (${victim.id}, ${n === 5 ? 'user.account_locked' : 'user.login_failed'}, 'user', ${victim.id}, ${JSON.stringify({ attempts: n + 1 })}::jsonb, ${daysAgo(1, 20 + Math.floor(n / 3))})`);
      }
    }

    // Solicitações de suporte: algumas abertas, uma respondida, uma resolvida e uma sem conta.
    const DEVICES = [
      { model: 'Galaxy A54', manufacturer: 'samsung', osVersion: '14', sdkInt: 34, appVersionCode: 25, appVersionName: '25', locale: 'pt-BR', timezone: 'America/Sao_Paulo' },
      { model: 'moto g54', manufacturer: 'motorola', osVersion: '13', sdkInt: 33, appVersionCode: 24, appVersionName: '24', locale: 'pt-BR', timezone: 'America/Sao_Paulo' },
      { model: 'Redmi Note 12', manufacturer: 'Xiaomi', osVersion: '12', sdkInt: 31, appVersionCode: 25, appVersionName: '25', locale: 'pt-BR', timezone: 'America/Manaus' },
    ];
    const TICKETS: Array<{ user: number | null; category: string; subject: string; message: string; status: 'open' | 'answered' | 'resolved'; reply?: string; daysAgo: number; priority?: string }> = [
      { user: 0, category: 'problem', subject: 'Relatório em PDF não abre', message: 'Quando toco em gerar o relatório completo o app fecha sozinho. Já reiniciei o celular.', status: 'open', daysAgo: 0, priority: 'high' },
      { user: 2, category: 'billing', subject: 'Cobrança duplicada no cartão', message: 'Apareceram duas cobranças da assinatura este mês. Podem verificar?', status: 'open', daysAgo: 2 },
      { user: 4, category: 'account', subject: 'Estoque não aparece no celular novo', message: 'Comprei outro aparelho, fiz login mas os produtos não baixaram.', status: 'answered', reply: 'Olá! Abra Conta e sincronização e toque em Sincronizar agora. Se continuar, me diga qual mensagem aparece na tela.', daysAgo: 1 },
      { user: 6, category: 'question', subject: 'Como convido um funcionário?', message: 'Quero que meu sócio também lance as saídas.', status: 'resolved', reply: 'Em Conta e sincronização > Equipe, toque em Convidar e informe o e-mail dele. Ele recebe um convite e entra com o papel que você escolher.', daysAgo: 5 },
      { user: null, category: 'suggestion', subject: 'Leitor de código de barras na saída', message: 'Seria ótimo bipar o produto direto na tela de saída.', status: 'open', daysAgo: 3 },
    ];
    // Reexecução: os usuários já existem (ON CONFLICT DO NOTHING), então os
    // donos das solicitações vêm do banco.
    const owners = users.length > 0
      ? users
      : (await db.execute<{ id: string; email: string; install_id: string }>(sql`
          SELECT u.id, u.email, d.install_id FROM users u JOIN devices d ON d.user_id = u.id
          WHERE u.email LIKE '%@exemplo.com.br' AND u.status = 'active' ORDER BY u.created_at LIMIT 20
        `)).rows.map((row) => ({ id: row.id, email: row.email, installId: row.install_id }));
    await db.execute(sql`DELETE FROM support_tickets WHERE install_id LIKE 'instalacao-anonima-%' OR user_id IN (SELECT id FROM users WHERE email LIKE '%@exemplo.com.br')`);
    let ticketsCreated = 0;
    for (const spec of TICKETS) {
      const owner = spec.user === null ? null : owners[spec.user];
      const createdAt = daysAgo(spec.daysAgo, 10);
      const device = DEVICES[ticketsCreated % DEVICES.length];
      const diagnostics = owner
        ? { signedIn: true, workspaceName: 'Empresa de exemplo', role: 'proprietario', subscriptionState: spec.category === 'billing' ? 'ativa' : 'sem_assinatura', canSync: spec.category === 'billing', lastSyncAt: createdAt.getTime() - 3_600_000, pendingOperations: spec.category === 'account' ? 7 : 0, failedOperations: 0, products: 120 + ticketsCreated * 13, notificationsEnabled: true }
        : { signedIn: false, products: 18, movements: 55, notificationsEnabled: true };
      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO support_tickets (user_id, install_id, contact_email, category, subject, status, priority, device, diagnostics, app_version_code, message_count, last_message_at, last_message_by, first_response_at, resolved_at, resolved_by, created_at)
        VALUES (${owner?.id ?? null}, ${owner?.installId ?? `instalacao-anonima-${ticketsCreated}`}, ${owner ? null : 'visitante@exemplo.com.br'}, ${spec.category}, ${spec.subject}, ${spec.status}, ${spec.priority ?? 'normal'},
                ${JSON.stringify(device)}::jsonb, ${JSON.stringify(diagnostics)}::jsonb, ${device?.appVersionCode ?? null},
                ${spec.reply ? (spec.status === 'resolved' ? 3 : 2) : 1}, ${spec.reply ? new Date(createdAt.getTime() + 7_200_000) : createdAt}, ${spec.reply ? (spec.status === 'resolved' ? 'system' : 'admin') : 'user'},
                ${spec.reply ? new Date(createdAt.getTime() + 5_400_000) : null}, ${spec.status === 'resolved' ? new Date(createdAt.getTime() + 7_200_000) : null}, ${spec.status === 'resolved' ? 'admin' : null}, ${createdAt})
        RETURNING id
      `);
      const ticketId = inserted.rows[0]?.id;
      if (!ticketId) continue;
      await db.execute(sql`INSERT INTO support_messages (ticket_id, author, body, created_at) VALUES (${ticketId}, 'user', ${spec.message}, ${createdAt})`);
      if (spec.reply) {
        await db.execute(sql`INSERT INTO support_messages (ticket_id, author, admin_name, body, notify_status, notify_detail, created_at) VALUES (${ticketId}, 'admin', 'André', ${spec.reply}, 'push', '1 aparelho(s)', ${new Date(createdAt.getTime() + 5_400_000)})`);
      }
      if (spec.status === 'resolved') {
        await db.execute(sql`INSERT INTO support_messages (ticket_id, author, body, created_at) VALUES (${ticketId}, 'system', 'Solicitação marcada como resolvida pela equipe.', ${new Date(createdAt.getTime() + 7_200_000)})`);
      }
      ticketsCreated += 1;
    }

    console.log(`seed concluído: ${ticketsCreated} solicitações de suporte, ${users.length} usuários, ${workspaces.length} empresas, ${total} eventos de uso. Senha de todos: ${PASSWORD}`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('falha no seed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
