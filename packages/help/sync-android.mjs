/**
 * A central de ajuda tem uma fonte só (esta pasta). A web e o painel
 * importam o JSON daqui; o app Android precisa dele dentro do APK, em
 * `app/src/main/assets/help`, porque a ajuda abre sem internet.
 *
 * Só `faq.json` vai para o app: `faq-admin.json` descreve procedimentos
 * internos e existe apenas no painel.
 *
 *   node sync-android.mjs          valida e copia para os assets do app
 *   node sync-android.mjs --check  valida e falha (exit 1) se a cópia estiver defasada
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');

/** Erros de estrutura quebrariam três telas de uma vez; melhor falhar aqui. */
function validate(file) {
  const data = JSON.parse(readFileSync(join(here, file), 'utf8'));
  const categories = new Set(data.categories.map((category) => category.id));
  const ids = new Set();
  for (const article of data.articles) {
    const where = `${file}: artigo "${article.id}"`;
    if (!/^[a-z0-9-]+$/.test(article.id ?? '')) throw new Error(`${where}: id inválido`);
    if (ids.has(article.id)) throw new Error(`${where}: id repetido`);
    ids.add(article.id);
    if (!categories.has(article.category)) throw new Error(`${where}: categoria desconhecida "${article.category}"`);
    if (!article.question?.trim()) throw new Error(`${where}: sem pergunta`);
    if (!Array.isArray(article.answer) || article.answer.length === 0) throw new Error(`${where}: sem resposta`);
    for (const platform of article.platforms ?? []) {
      if (platform !== 'android' && platform !== 'web') throw new Error(`${where}: plataforma desconhecida "${platform}"`);
    }
  }
  for (const category of categories) {
    if (!data.articles.some((article) => article.category === category)) throw new Error(`${file}: categoria "${category}" sem artigos`);
  }
  return ids;
}

const userIds = validate('faq.json');
const adminIds = validate('faq-admin.json');
for (const id of adminIds) {
  if (userIds.has(id)) throw new Error(`id "${id}" existe nos dois arquivos; o painel junta os dois`);
}

if (!existsSync(join(here, '..', '..', 'apps', 'android'))) {
  // Build de deploy: o app Android não entra no contexto. Nada a copiar.
  console.log('Ajuda válida; apps/android ausente, nada a sincronizar.');
  process.exit(0);
}

const target = join(here, '..', '..', 'apps', 'android', 'app', 'src', 'main', 'assets', 'help');
const destination = join(target, 'faq.json');
const source = readFileSync(join(here, 'faq.json'));
const same = existsSync(destination) && readFileSync(destination).equals(source);

if (same) {
  console.log('Ajuda do app em dia.');
} else if (check) {
  console.error('defasado: apps/android/app/src/main/assets/help/faq.json');
  console.error('Rode "npm run help:sync" e versione o resultado.');
  process.exit(1);
} else {
  mkdirSync(target, { recursive: true });
  copyFileSync(join(here, 'faq.json'), destination);
  console.log('copiado: faq.json → assets do app');
}
