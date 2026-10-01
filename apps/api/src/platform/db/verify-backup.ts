import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import pg from 'pg';

import { loadMigrations } from './migrate.js';

/**
 * Exercício de restauração.
 *
 * Backup nunca restaurado é uma suposição, não uma cópia de segurança — e a
 * hora de descobrir que o arquivo está truncado não é durante um incidente.
 * Este script restaura um dump num banco descartável, confere que as tabelas
 * essenciais vieram com conteúdo e registra o resultado na API, para que a
 * ausência de uma verificação recente apareça no plantão.
 *
 * Uso:
 *   npm run backup:verify -- --dump caminho/do/arquivo.dump --target postgres://...
 *
 * O banco alvo precisa ser descartável: ele é apagado e recriado.
 */

const executar = promisify(execFile);

/** Tabelas cujo esvaziamento significa backup inútil, ainda que o arquivo abra. */
const TABELAS_ESSENCIAIS = [
  'users',
  'workspaces',
  'workspace_members',
  'products',
  'stock_movements',
];

/** Identificador simples, sem aspas nem maiúsculas. Ver `conferir`. */
const IDENTIFICADOR_SIMPLES = /^[a-z_][a-z0-9_]*$/;

interface Argumentos {
  dump: string;
  target: string;
  apiUrl: string | undefined;
  opsToken: string | undefined;
}

interface Endereco {
  host: string;
  porta: string;
  banco: string;
}

function endereco(url: string): Endereco {
  const parsed = new URL(url);
  return {
    host: parsed.hostname.toLowerCase(),
    porta: parsed.port || '5432',
    banco: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

/**
 * O alvo é apagado e recriado (`--clean --if-exists`). Apontá-lo, por descuido
 * de shell ou por uma variável herdada do ambiente, para o mesmo banco que a
 * API usa transformaria o exercício de restauração no incidente que ele existe
 * para evitar. Na dúvida — URL que não dá para interpretar — o script recusa.
 */
function recusarSeForProducao(target: string): void {
  const producao = process.env['DATABASE_URL'];
  if (!producao) return;

  let alvo: Endereco;
  let atual: Endereco;
  try {
    alvo = endereco(target);
    atual = endereco(producao);
  } catch {
    throw new Error(
      'Não foi possível comparar --target com DATABASE_URL. Como o alvo é apagado, ' +
        'o exercício só roda com as duas URLs em formato reconhecível.',
    );
  }

  if (alvo.host === atual.host && alvo.porta === atual.porta && alvo.banco === atual.banco) {
    throw new Error(
      `--target aponta para ${alvo.host}:${alvo.porta}/${alvo.banco}, que é o banco de ` +
        'DATABASE_URL. O alvo precisa ser um banco descartável: ele seria apagado e recriado.',
    );
  }
}

function lerArgumentos(): Argumentos {
  const args = process.argv.slice(2);
  const valor = (nome: string): string | undefined => {
    const indice = args.indexOf(`--${nome}`);
    return indice >= 0 ? args[indice + 1] : undefined;
  };

  const dump = valor('dump');
  const target = valor('target') ?? process.env['BACKUP_VERIFY_DATABASE_URL'];

  if (!dump || !target) {
    throw new Error(
      'Uso: npm run backup:verify -- --dump <arquivo> --target <url do banco descartável>',
    );
  }

  recusarSeForProducao(target);

  return {
    dump,
    target,
    apiUrl: valor('api') ?? process.env['API_BASE_URL'],
    opsToken: process.env['OPS_TOKEN'],
  };
}

/**
 * O dump traz GRANTs para `app_user`, e o papel é do cluster, não do banco.
 * Se ele não existir no alvo, cada GRANT falha e — com `--single-transaction` —
 * a restauração inteira é abortada.
 */
async function garantirPapelApp(target: string): Promise<void> {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user NOLOGIN;
        END IF;
      END
      $$
    `);
  } catch (error) {
    throw new Error(
      'Não foi possível garantir o papel app_user no alvo. Sem ele os GRANTs do dump ' +
        `falham e o exercício não prova nada: ${(error as Error).message}`,
    );
  } finally {
    await client.end();
  }
}

async function restaurar(dump: string, target: string): Promise<void> {
  // Distribuições instalam o binário em caminhos versionados, e a versão do
  // cliente precisa acompanhar a do servidor: pg_restore antigo recusa dumps
  // de um Postgres mais novo.
  const binario = process.env['PG_RESTORE_BIN'] ?? 'pg_restore';

  // `--clean --if-exists` deixa o alvo no estado do dump mesmo que ele já
  // tenha sido usado num exercício anterior. Sem isso, dados remanescentes
  // fariam a contagem passar com um backup vazio.
  //
  // `--no-privileges` foi removido de propósito: os GRANTs por coluna e o
  // papel app_user são parte do isolamento entre empresas, e um exercício que
  // os descarta prova apenas que as linhas voltaram — não que o banco
  // restaurado poderia atender tráfego sem vazar dados de um cliente para
  // outro. `--no-owner` continua, porque o dono das tabelas no alvo descartável
  // é quem estiver restaurando.
  await executar(binario, [
    '--dbname',
    target,
    '--clean',
    '--if-exists',
    '--no-owner',
    '--single-transaction',
    dump,
  ]);
}

interface Conferencia {
  tabelas: number;
  registros: number;
  politicas: number;
  grants: number;
  migracao: number;
}

async function conferir(target: string): Promise<Conferencia> {
  const client = new pg.Client({ connectionString: target });
  await client.connect();

  try {
    const tabelas = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM pg_tables WHERE schemaname = 'public'`,
    );

    // O nome da tabela nunca é concatenado cru na consulta. A lista é
    // constante, mas quem a edita amanhã não deveria conseguir abrir uma
    // injeção sem perceber: o identificador é validado aqui, confirmado contra
    // pg_tables e escapado pelo próprio servidor com quote_ident.
    for (const tabela of TABELAS_ESSENCIAIS) {
      if (!IDENTIFICADOR_SIMPLES.test(tabela)) {
        throw new Error(`Nome de tabela inválido na lista de essenciais: ${tabela}`);
      }
    }

    const identificadores = await client.query<{ tabela: string; ident: string }>(
      `SELECT t AS tabela, quote_ident(t) AS ident
         FROM unnest($1::text[]) AS t
        WHERE EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
        )`,
      [TABELAS_ESSENCIAIS],
    );

    if (identificadores.rows.length !== TABELAS_ESSENCIAIS.length) {
      const presentes = new Set(identificadores.rows.map((row) => row.tabela));
      const ausentes = TABELAS_ESSENCIAIS.filter((tabela) => !presentes.has(tabela));
      throw new Error(`O dump não traz as tabelas: ${ausentes.join(', ')}.`);
    }

    let registros = 0;
    const vazias: string[] = [];

    for (const { tabela, ident } of identificadores.rows) {
      const resultado = await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM public.${ident}`,
      );
      const total = Number(resultado.rows[0]?.total ?? 0);
      registros += total;
      if (total === 0) vazias.push(tabela);
    }

    if (vazias.length > 0) {
      throw new Error(
        `Restauração concluída mas sem dados em: ${vazias.join(', ')}. ` +
          'Um backup que abre e vem vazio é pior do que nenhum, porque passa despercebido.',
      );
    }

    // As políticas de RLS e os GRANTs de app_user são o isolamento entre
    // empresas. Um banco restaurado sem eles sobe, responde e serve os dados de
    // um cliente para outro — o pior resultado possível para uma restauração
    // que se declarou bem-sucedida.
    const politicas = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM pg_policies WHERE schemaname = 'public'`,
    );
    if (Number(politicas.rows[0]?.total ?? 0) === 0) {
      throw new Error(
        'O banco restaurado não tem nenhuma política de RLS. O dump foi gerado ou ' +
          'restaurado sem elas, e um banco assim não isola uma empresa da outra.',
      );
    }

    const grants = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM information_schema.role_table_grants
        WHERE grantee = 'app_user' AND table_schema = 'public'`,
    );
    if (Number(grants.rows[0]?.total ?? 0) === 0) {
      throw new Error(
        'O banco restaurado não tem nenhum GRANT para app_user. Sem eles o papel de ' +
          'tenant não enxerga nada e a restauração não é utilizável.',
      );
    }

    // Contar linhas em schema_migrations não diz nada: o que importa é o dump
    // ter chegado até a última migration que existe no repositório. Um backup
    // de um schema anterior restaura sem erro e quebra na primeira consulta que
    // usar uma coluna nova.
    const noDisco = await loadMigrations();
    const ultimaEsperada = noDisco.reduce((maior, m) => Math.max(maior, m.version), 0);
    const migracao = await client.query<{ maior: string | null }>(
      `SELECT max(version)::text AS maior FROM schema_migrations`,
    );
    const ultimaRestaurada = Number(migracao.rows[0]?.maior ?? 0);

    if (ultimaRestaurada !== ultimaEsperada) {
      throw new Error(
        `O dump está na migration ${ultimaRestaurada} e o repositório está na ` +
          `${ultimaEsperada}. O backup não reconstrói o ambiente atual.`,
      );
    }

    return {
      tabelas: Number(tabelas.rows[0]?.total ?? 0),
      registros,
      politicas: Number(politicas.rows[0]?.total ?? 0),
      grants: Number(grants.rows[0]?.total ?? 0),
      migracao: ultimaRestaurada,
    };
  } finally {
    await client.end();
  }
}

async function registrar(
  config: Argumentos,
  resultado: { tabelas: number; registros: number; duracaoSegundos: number },
): Promise<void> {
  if (!config.apiUrl || !config.opsToken) {
    console.log('API_BASE_URL ou OPS_TOKEN ausentes: resultado não registrado na API.');
    return;
  }

  const resposta = await fetch(`${config.apiUrl}/ops/backup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.opsToken}`,
    },
    body: JSON.stringify({ origem: config.dump, ...resultado }),
  });

  if (!resposta.ok) {
    throw new Error(`Falha ao registrar a verificação: ${resposta.status}`);
  }
}

async function main(): Promise<void> {
  const config = lerArgumentos();
  const arquivo = await stat(config.dump);
  const inicio = Date.now();

  console.log(`Restaurando ${config.dump} (${Math.round(arquivo.size / 1024)} KiB)...`);
  await garantirPapelApp(config.target);
  await restaurar(config.dump, config.target);

  const { tabelas, registros, politicas, grants, migracao } = await conferir(config.target);
  const duracaoSegundos = Math.round((Date.now() - inicio) / 100) / 10;

  console.log(
    `Backup íntegro: ${tabelas} tabela(s), ${registros} registro(s) nas tabelas essenciais, ` +
      `${politicas} política(s) de RLS, ${grants} GRANT(s) para app_user, ` +
      `migration ${migracao}, ${duracaoSegundos}s de restauração.`,
  );

  await registrar(config, { tabelas, registros, duracaoSegundos });
}

main().catch((error: unknown) => {
  console.error(
    'verificação de backup falhou:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
