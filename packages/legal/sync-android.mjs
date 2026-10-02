/**
 * Os documentos legais têm uma fonte só (esta pasta). A aplicação web os
 * importa direto daqui; o app Android precisa deles dentro do APK, em
 * `app/src/main/assets/legal`, porque a tela funciona sem internet.
 *
 *   node sync-android.mjs          copia para os assets do app
 *   node sync-android.mjs --check  falha (exit 1) se a cópia estiver defasada
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', '..', 'apps', 'android', 'app', 'src', 'main', 'assets', 'legal');
const files = ['termos.html', 'privacidade.html', 'style.css'];
const check = process.argv.includes('--check');

if (!existsSync(join(here, '..', '..', 'apps', 'android'))) {
  // Build de deploy: o app Android não entra no contexto. Nada a fazer.
  console.log('apps/android ausente; nada a sincronizar.');
  process.exit(0);
}

let stale = 0;
mkdirSync(target, { recursive: true });
for (const file of files) {
  const source = readFileSync(join(here, file));
  const destination = join(target, file);
  const same = existsSync(destination) && readFileSync(destination).equals(source);
  if (same) continue;
  stale += 1;
  if (check) console.error(`defasado: apps/android/app/src/main/assets/legal/${file}`);
  else {
    copyFileSync(join(here, file), destination);
    console.log(`copiado: ${file}`);
  }
}

if (check && stale > 0) {
  console.error('Rode "npm run legal:sync" e versione o resultado.');
  process.exit(1);
}
console.log(check ? 'Documentos legais do app em dia.' : stale === 0 ? 'Nada mudou.' : 'Assets do app atualizados.');
