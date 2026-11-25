/**
 * As novidades têm uma fonte só (esta pasta). A web importa o JSON daqui; o
 * app Android precisa dele dentro do APK, em `app/src/main/assets/changelog`,
 * porque a tela abre sem internet.
 *
 *   node sync-android.mjs          valida e copia para os assets do app
 *   node sync-android.mjs --check  valida e falha (exit 1) se a cópia estiver defasada
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');

/** Uma lista torta quebraria a tela nas duas pontas; melhor falhar aqui. */
function validate() {
  const data = JSON.parse(readFileSync(join(here, 'releases.json'), 'utf8'));
  if (!Array.isArray(data.releases) || data.releases.length === 0) {
    throw new Error('releases.json: sem versões');
  }
  const vistos = new Set();
  for (const release of data.releases) {
    const onde = `releases.json: versão ${release.version}`;
    if (!Number.isInteger(release.version) || release.version <= 0) throw new Error(`${onde}: número inválido`);
    if (vistos.has(release.version)) throw new Error(`${onde}: repetida`);
    vistos.add(release.version);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date ?? '')) throw new Error(`${onde}: data fora do formato YYYY-MM-DD`);
    if (!release.title?.trim()) throw new Error(`${onde}: sem título`);
    for (const campo of ['highlights', 'fixes']) {
      if (!Array.isArray(release[campo])) throw new Error(`${onde}: ${campo} precisa ser uma lista`);
      for (const linha of release[campo]) {
        if (typeof linha !== 'string' || !linha.trim()) throw new Error(`${onde}: ${campo} com linha vazia`);
      }
    }
    // Versão que não diz nada é pior do que versão ausente: a pessoa abre a
    // tela e encontra um título sozinho.
    if (release.highlights.length === 0 && release.fixes.length === 0) {
      throw new Error(`${onde}: sem novidades nem correções`);
    }
  }
  return data;
}

validate();

const destino = join(here, '..', '..', 'apps', 'android', 'app', 'src', 'main', 'assets', 'changelog');
if (!existsSync(join(here, '..', '..', 'apps', 'android'))) {
  // Build de deploy: o app Android não entra no contexto. Nada a copiar.
  console.log('Novidades válidas; apps/android ausente, nada a sincronizar.');
  process.exit(0);
}

const origem = join(here, 'releases.json');
const copia = join(destino, 'releases.json');

if (check) {
  if (!existsSync(copia) || readFileSync(copia, 'utf8') !== readFileSync(origem, 'utf8')) {
    console.error('A cópia das novidades no app está defasada. Rode: npm run changelog:sync');
    process.exit(1);
  }
  console.log('Novidades do app em dia.');
  process.exit(0);
}

mkdirSync(destino, { recursive: true });
copyFileSync(origem, copia);
console.log('copiado: releases.json → assets do app');
