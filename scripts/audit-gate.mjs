#!/usr/bin/env node
/**
 * Portão de dependências do CI: falha com vulnerabilidade alta ou crítica nas
 * dependências de produção (`npm audit --omit=dev`), exceto as aceitas abaixo,
 * cada uma com motivo, mitigação e data de validade — vencida a data, volta a
 * falhar e obriga a decidir de novo.
 */
import { execFileSync } from 'node:child_process';

const ACCEPTED = {
  // Zod 3 não tem correção (a faixa afetada é <4.6.6); a migração para o Zod 4
  // muda a API dos esquemas em toda a API. Mitigação: corpo limitado em
  // BODY_LIMIT_BYTES (1 MB; 5 MB na sincronização) e listas com .max() nos
  // esquemas, então não há como mandar uma coleção grande o bastante.
  'GHSA-mrhx-c7xc-m3w5': { until: '2027-01-31', reason: 'Zod 3 sem correção; migração para Zod 4 planejada' },
};

let report;
try {
  report = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // `npm audit` sai com código diferente de zero quando encontra algo; o JSON vem mesmo assim.
  report = error.stdout;
}
const data = JSON.parse(report);
const today = new Date().toISOString().slice(0, 10);
const failures = [];
for (const [name, vuln] of Object.entries(data.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(vuln.severity)) continue;
  const advisories = (vuln.via ?? []).filter((item) => typeof item === 'object');
  if (advisories.length === 0) continue; // só herdado de outro pacote: o pacote de origem é avaliado por si
  for (const advisory of advisories) {
    const id = String(advisory.url ?? '').split('/').pop();
    const accepted = ACCEPTED[id];
    if (accepted && accepted.until >= today) {
      console.log(`aceito até ${accepted.until}: ${name} ${id} (${accepted.reason})`);
      continue;
    }
    failures.push(`${vuln.severity.toUpperCase()} ${name}: ${advisory.title} ${advisory.url}${accepted ? ` (aceite vencido em ${accepted.until})` : ''}`);
  }
}
if (failures.length > 0) {
  console.error(`Dependências de produção com vulnerabilidade alta/crítica:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('Dependências de produção: nenhuma vulnerabilidade alta/crítica fora da lista de aceites.');
