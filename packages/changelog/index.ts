/**
 * Novidades do app: o que mudou em cada versão, em fonte única.
 *
 * A web importa este módulo; o app Android lê uma cópia de `releases.json`
 * nos assets (a tela abre sem internet, como a ajuda). O número da versão é
 * o `versionCode` do Android — é ele que o aparelho conhece e o que o
 * servidor compara para avisar que saiu versão nova.
 *
 * O texto é escrito para quem usa, não para quem programa: "o que você ganha"
 * em `highlights`, "o que estava errado e foi consertado" em `fixes`. Versão
 * sem nada visível para o cliente entra mesmo assim, com uma linha honesta em
 * `fixes` — pular versões faria a lista parecer incompleta.
 */

export interface Release {
  /** `versionCode` do Android. */
  version: number;
  /** Dia do lançamento, `YYYY-MM-DD`. */
  date: string;
  title: string;
  /** O que a pessoa ganhou. */
  highlights: string[];
  /** O que foi corrigido. */
  fixes: string[];
}

export interface Changelog {
  version: number;
  updatedAt: string;
  releases: Release[];
}

import data from './releases.json' with { type: 'json' };

/** Da mais nova para a mais antiga, que é como a tela mostra. */
export const changelog: Changelog = data as Changelog;

export const releases: Release[] = [...changelog.releases].sort((a, b) => b.version - a.version);

/** A versão mais nova que esta build conhece; serve de rótulo na tela. */
export function latestRelease(): Release | undefined {
  return releases[0];
}

/** `2026-11-25` → `25/11/2026`; dia de calendário não tem fuso. */
export function formatReleaseDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}
