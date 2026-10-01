/**
 * Métricas no formato de exposição do Prometheus.
 *
 * Implementadas à mão, sem biblioteca de instrumentação. O conjunto que
 * importa aqui cabe em cem linhas — contadores, um histograma de latência e
 * alguns valores lidos do banco na hora da coleta — e uma dependência a mais
 * significaria mais uma coisa para atualizar por vulnerabilidade em um serviço
 * que roda com uma instância.
 *
 * Regra que vale para tudo neste arquivo: rótulo nenhum pode conter valor
 * vindo do usuário. Cardinalidade explode silenciosamente e derruba a coleta
 * inteira, não só a métrica culpada.
 */

type Labels = Record<string, string | number>;

interface CounterState {
  help: string;
  values: Map<string, { labels: Labels; value: number }>;
}

interface HistogramState {
  help: string;
  buckets: number[];
  values: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
}

const counters = new Map<string, CounterState>();
const histograms = new Map<string, HistogramState>();

function chave(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((nome) => `${nome}=${String(labels[nome])}`)
    .join(',');
}

export function incrementCounter(name: string, help: string, labels: Labels = {}, delta = 1): void {
  const counter = counters.get(name) ?? { help, values: new Map() };
  const id = chave(labels);
  const atual = counter.values.get(id) ?? { labels, value: 0 };
  atual.value += delta;
  counter.values.set(id, atual);
  counters.set(name, counter);
}

export function observeHistogram(
  name: string,
  help: string,
  buckets: number[],
  labels: Labels,
  value: number,
): void {
  const histogram = histograms.get(name) ?? { help, buckets, values: new Map() };
  const id = chave(labels);
  const atual = histogram.values.get(id) ?? {
    labels,
    counts: new Array<number>(buckets.length).fill(0),
    sum: 0,
    count: 0,
  };

  for (let i = 0; i < buckets.length; i += 1) {
    const limite = buckets[i];
    if (limite !== undefined && value <= limite) {
      atual.counts[i] = (atual.counts[i] ?? 0) + 1;
    }
  }
  atual.sum += value;
  atual.count += 1;

  histogram.values.set(id, atual);
  histograms.set(name, histogram);
}

/** Usado pelos testes, que precisam de contadores previsíveis entre casos. */
export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}

function formatLabels(labels: Labels, extra?: Labels): string {
  const todos = { ...labels, ...extra };
  const partes = Object.entries(todos).map(
    ([nome, valor]) => `${nome}="${String(valor).replace(/["\\\n]/g, '_')}"`,
  );
  return partes.length > 0 ? `{${partes.join(',')}}` : '';
}

/** Métricas lidas do banco no momento da coleta, não acumuladas em memória. */
export interface GaugeSample {
  name: string;
  help: string;
  value: number;
  labels?: Labels;
}

export function renderMetrics(gauges: GaugeSample[] = []): string {
  const linhas: string[] = [];

  for (const [name, counter] of counters) {
    linhas.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`);
    for (const { labels, value } of counter.values.values()) {
      linhas.push(`${name}${formatLabels(labels)} ${value}`);
    }
  }

  for (const [name, histogram] of histograms) {
    linhas.push(`# HELP ${name} ${histogram.help}`, `# TYPE ${name} histogram`);
    for (const entrada of histogram.values.values()) {
      histogram.buckets.forEach((limite, i) => {
        linhas.push(
          `${name}_bucket${formatLabels(entrada.labels, { le: limite })} ${entrada.counts[i] ?? 0}`,
        );
      });
      linhas.push(
        `${name}_bucket${formatLabels(entrada.labels, { le: '+Inf' })} ${entrada.count}`,
        `${name}_sum${formatLabels(entrada.labels)} ${entrada.sum}`,
        `${name}_count${formatLabels(entrada.labels)} ${entrada.count}`,
      );
    }
  }

  for (const gauge of gauges) {
    linhas.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
    linhas.push(`${gauge.name}${formatLabels(gauge.labels ?? {})} ${gauge.value}`);
  }

  return `${linhas.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Métricas de negócio
//
// Nomeadas em inglês por convenção do ecossistema de coleta, ao contrário do
// resto do código: são consumidas por dashboards e alertas, não lidas aqui.
// ---------------------------------------------------------------------------

export const HTTP_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const labels = { method, route, status: statusCode };
  incrementCounter('http_requests_total', 'Requisições HTTP atendidas', labels);
  observeHistogram(
    'http_request_duration_seconds',
    'Duração das requisições HTTP',
    HTTP_DURATION_BUCKETS,
    { method, route },
    durationSeconds,
  );
}

export function recordSyncOperation(
  result: 'aplicada' | 'duplicada' | 'conflito' | 'rejeitada',
): void {
  incrementCounter('sync_operations_total', 'Operações de sincronização recebidas', { result });
}

export function recordSyncPull(changes: number): void {
  incrementCounter('sync_pull_changes_total', 'Alterações enviadas aos aparelhos', {}, changes);
}

export function recordConflict(kind: string): void {
  incrementCounter('sync_conflicts_total', 'Conflitos registrados', { kind });
}

export function recordJobResult(kind: string, result: 'ok' | 'erro' | 'esgotada'): void {
  incrementCounter('jobs_processed_total', 'Tarefas processadas pela fila', { kind, result });
}

export function recordBillingEvent(result: 'aceito' | 'ignorado' | 'erro'): void {
  incrementCounter('billing_notifications_total', 'Notificações do Google Play', { result });
}
