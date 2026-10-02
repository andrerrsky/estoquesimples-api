import { useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, api, download, errorMessage } from '../api/client';
import type { ImportResult, ImportRow } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Badge, Card, Notice, PageHeader, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { parseCsv, sheetToRows, type ParsedSheet } from '../lib/csv';
import { fmtInteger, fmtQuantity, plural } from '../lib/format';
import { useInvalidateInventory } from '../lib/inventory';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-stock.css';

/** A API aceita no máximo 1000 linhas por chamada. */
const CHUNK = 1000;
const PREVIEW_ROWS = 8;
const ERRORS_ON_SCREEN = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Pelo código, e não como caractere no fonte: os dois são invisíveis ou
// ilegíveis num editor e sumiriam numa reformatação.
/** Marca de início de arquivo (U+FEFF) que faz o Excel abrir o CSV como UTF-8. */
const BOM = String.fromCharCode(0xfeff);
/** Caractere que aparece (U+FFFD) quando um texto que não é UTF-8 é lido como UTF-8. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

const COLUMN_LABEL: Record<keyof ImportRow, string> = {
  id: 'Código interno',
  name: 'Nome',
  description: 'Descrição',
  quantity: 'Quantidade',
  unitValue: 'Valor unitário',
  minStock: 'Estoque mínimo',
  unit: 'Unidade',
  category: 'Categoria',
  supplier: 'Fornecedor',
  location: 'Localização',
  sku: 'SKU',
  barcode: 'Código de barras',
};

/**
 * Planilha modelo: os mesmos nomes de coluna que a leitura reconhece
 * (`lib/csv.ts`) e que a exportação de produtos usa. Ponto e vírgula e BOM
 * para o Excel em português abrir direto, com acentos e colunas no lugar.
 */
const TEMPLATE_HEADER = ['nome', 'descricao', 'quantidade', 'valor', 'categoria', 'sku', 'codigo_barras', 'fornecedor', 'localizacao', 'estoque_minimo', 'unidade'];
const TEMPLATE_EXAMPLE = ['Camiseta básica P', 'Algodão, cor branca', '10', '29,90', 'Roupas', 'CAM-P-01', '7890000000017', 'Fornecedor Exemplo', 'Prateleira A', '2', 'un'];

interface Picked {
  fileName: string;
  sheet: ParsedSheet;
}

interface Outcome {
  result: ImportResult;
  /** Linhas enviadas até parar (igual ao total quando deu tudo certo). */
  sent: number;
  total: number;
  /** Erro que interrompeu a importação no meio, se houve. */
  failure: unknown;
}

type ExportKind = 'products' | 'movements' | 'backup';

function saveText(content: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Lê o arquivo como texto. Planilhas salvas por versões antigas do Excel vêm
 * em Latin-1: lidas como UTF-8, os acentos viram o caractere de substituição (U+FFFD). Nesse caso o arquivo é
 * relido com a codificação do Windows.
 */
async function readSheet(file: File): Promise<string> {
  const text = await file.text();
  if (!text.includes(REPLACEMENT_CHAR)) return text;
  return new TextDecoder('windows-1252').decode(await file.arrayBuffer());
}

function cell(row: ImportRow, column: keyof ImportRow): string {
  const value = row[column];
  if (value === undefined) return '';
  return typeof value === 'number' ? fmtQuantity(value) : value;
}

/**
 * Importar e exportar. A planilha é lida no próprio navegador (o arquivo não
 * é enviado; só as linhas interpretadas) e a prévia mostra o que foi
 * entendido antes de qualquer gravação. Quem casa linha com produto, cria,
 * atualiza ou recusa é a API — a tela só mostra o resultado.
 */
export function ImportExportPage() {
  const { workspaceId, base, can } = useCurrentWorkspace();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);
  const input = useRef<HTMLInputElement | null>(null);

  const [picked, setPicked] = useState<Picked | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [exporting, setExporting] = useState<ExportKind | null>(null);

  const canImport = can('produtos.criar');
  const running = progress !== null;

  const reset = () => {
    setPicked(null);
    setReadError(null);
    setOutcome(null);
    if (input.current) input.current.value = '';
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // Limpa o campo para que escolher o mesmo arquivo de novo (depois de
    // corrigi-lo) dispare a leitura outra vez.
    event.target.value = '';
    setPicked(null);
    setOutcome(null);
    setReadError(null);
    if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) {
      return setReadError('Este arquivo é uma planilha do Excel. Abra-a e use “Salvar como” → CSV; depois escolha o arquivo .csv aqui.');
    }
    if (file.size > MAX_FILE_BYTES) return setReadError('O arquivo passa de 10 MB. Divida a planilha em partes menores.');
    try {
      const sheet = sheetToRows(parseCsv(await readSheet(file)));
      if (sheet.rows.length === 0 && !sheet.isMovements) return setReadError('Não encontramos nenhuma linha com dados neste arquivo.');
      setPicked({ fileName: file.name, sheet });
    } catch {
      setReadError('Não foi possível ler o arquivo. Confira se ele é um CSV.');
    }
  };

  const run = async () => {
    if (!picked || running) return;
    const { rows } = picked.sheet;
    const total: ImportResult = { created: 0, updated: 0, unchanged: 0, errors: 0, lines: [] };
    let sent = 0;
    let failure: unknown = null;
    setOutcome(null);
    setProgress({ sent: 0, total: rows.length });

    // Um lote por vez, em ordem: linhas repetidas na planilha dependem do que
    // o lote anterior gravou, e a API recusa mais de 1000 linhas por chamada.
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      try {
        const result = await api.post<ImportResult>(`${base}/products/import`, { rows: chunk });
        total.created += result.created;
        total.updated += result.updated;
        total.unchanged += result.unchanged;
        total.errors += result.errors;
        // O índice volta relativo ao lote; aqui vira a posição na planilha.
        for (const line of result.lines) total.lines.push({ ...line, index: line.index + start });
        sent += chunk.length;
        setProgress({ sent, total: rows.length });
      } catch (error) {
        failure = error;
        break;
      }
    }

    setProgress(null);
    setOutcome({ result: total, sent, total: rows.length, failure });
    const changed = total.created + total.updated;
    if (sent > 0) {
      invalidate();
      track('import.completed', { format: 'csv', count: changed });
    }
    if (!failure) toast.success(`Importação concluída: ${plural(total.created, 'produto novo', 'produtos novos')}, ${plural(total.updated, 'atualizado', 'atualizados')}.`);
  };

  const downloadTemplate = () => {
    const quote = (value: string) => (/[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = [TEMPLATE_HEADER, TEMPLATE_EXAMPLE].map((line) => line.map(quote).join(';'));
    saveText(`${BOM}${lines.join('\r\n')}\r\n`, 'modelo-produtos.csv', 'text/csv;charset=utf-8');
  };

  const runExport = async (kind: ExportKind) => {
    setExporting(kind);
    try {
      if (kind === 'products') await download(`${base}/export/produtos.csv`, 'produtos.csv');
      else if (kind === 'movements') await download(`${base}/export/movimentacoes.csv`, 'movimentacoes.csv');
      else await download(`${base}/export`, `estoque-simples-backup-${new Date().toLocaleDateString('en-CA')}.json`);
      track('export.completed', { format: kind === 'backup' ? 'json' : 'csv' });
    } catch (error) {
      toast.error(error);
    } finally {
      setExporting(null);
    }
  };

  const sheet = picked?.sheet;
  const failure = outcome?.failure;
  const planLimit = failure instanceof ApiError && failure.code === 'PLAN_LIMIT_REACHED' ? failure : null;
  const errorLines = outcome?.result.lines.filter((line) => line.outcome === 'error') ?? [];

  const exportRow = (kind: ExportKind, icon: IconName, title: string, text: string, label: string) => (
    <div className="list__item">
      <Icon name={icon} className="muted" />
      <div className="list__main">
        <div className="list__title">{title}</div>
        <div className="list__sub">{text}</div>
      </div>
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => void runExport(kind)} disabled={exporting !== null}>
        <Icon name="download" size={15} /> {exporting === kind ? 'Preparando…' : label}
      </button>
    </div>
  );

  return (
    <div className="page">
      <PageHeader title="Importar e exportar" subtitle="Traga os produtos de uma planilha ou leve uma cópia dos seus dados" />

      <Card title="Importar produtos de uma planilha" subtitle="Arquivo CSV, como o que o Excel e o Planilhas Google salvam">
        {!canImport ? (
          <Notice tone="info">Seu acesso não permite cadastrar produtos, por isso a importação não está disponível. Peça a quem administra a empresa.</Notice>
        ) : (
          <div className="stack">
            <div className="file-pick">
              <Icon name="upload" className="muted" />
              <div className="file-pick__name">{picked ? <strong>{picked.fileName}</strong> : <span className="muted">Nenhum arquivo escolhido. O arquivo é lido aqui mesmo, no seu navegador.</span>}</div>
              <input ref={input} type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(event) => void pick(event)} aria-label="Escolher arquivo CSV" tabIndex={-1} />
              <button type="button" className={`btn ${picked ? 'btn--ghost' : 'btn--primary'} btn--sm`} onClick={() => input.current?.click()} disabled={running}>
                {picked ? 'Trocar arquivo' : 'Escolher arquivo'}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={downloadTemplate}>
                <Icon name="download" size={15} /> Baixar modelo
              </button>
            </div>

            {readError && <Notice tone="error">{readError}</Notice>}

            {sheet && !outcome && (
              <>
                {sheet.isMovements ? (
                  <Notice tone="warning" title="Este arquivo é de movimentações">
                    A importação daqui cadastra e atualiza produtos. O histórico de movimentações não é importado por planilha.
                  </Notice>
                ) : (
                  <>
                    <div>
                      <div className="strong">
                        {plural(sheet.rows.length, 'linha com dados', 'linhas com dados')}
                        {sheet.skipped > 0 && <span className="muted"> · {plural(sheet.skipped, 'linha sem dados ignorada', 'linhas sem dados ignoradas')}</span>}
                      </div>
                      <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
                        <span className="caption">Colunas reconhecidas:</span>
                        {sheet.columns.map((column) => (
                          <Badge key={column} tone="brand">
                            {COLUMN_LABEL[column]}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {!sheet.hasHeader && (
                      <Notice tone="info">
                        A primeira linha não parece um cabeçalho, então as colunas foram lidas na ordem do modelo (nome, descrição, quantidade, valor…). Confira a prévia; se estiver trocado,
                        baixe o modelo e copie os nomes das colunas.
                      </Notice>
                    )}
                    {!sheet.columns.includes('name') && (
                      <Notice tone="warning" title="A planilha não tem a coluna “nome”">
                        Só os produtos já cadastrados (encontrados pelo SKU, código de barras ou código interno) serão atualizados. Linhas de produtos novos, sem nome, voltam como erro.
                      </Notice>
                    )}

                    <div className="table-wrap card card--flush card--muted">
                      <table className="table preview-table">
                        <thead>
                          <tr>
                            {sheet.columns.map((column) => (
                              <th key={column} className={column === 'quantity' || column === 'unitValue' || column === 'minStock' ? 'num' : undefined}>
                                {COLUMN_LABEL[column]}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sheet.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                            <tr key={index}>
                              {sheet.columns.map((column) => (
                                <td key={column} className={column === 'quantity' || column === 'unitValue' || column === 'minStock' ? 'num' : undefined} title={cell(row, column)}>
                                  {cell(row, column) || <span className="faint">—</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {sheet.rows.length > PREVIEW_ROWS && <p className="caption">Prévia das primeiras {PREVIEW_ROWS} linhas de {fmtInteger(sheet.rows.length)}.</p>}

                    <div className="row row--end row--wrap">
                      {running && progress && (
                        <span className="muted" role="status">
                          Importando… {fmtInteger(progress.sent)} de {fmtInteger(progress.total)}
                        </span>
                      )}
                      <button type="button" className="btn btn--ghost" onClick={reset} disabled={running}>
                        Cancelar
                      </button>
                      <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={running || sheet.rows.length === 0}>
                        <Icon name="upload" size={17} /> {running ? 'Importando…' : `Importar ${plural(sheet.rows.length, 'linha', 'linhas')}`}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {outcome && (
              <div className="stack">
                {planLimit ? (
                  <Notice
                    tone="warning"
                    title={typeof planLimit.extra['limit'] === 'number' ? `A planilha passa do limite de ${fmtInteger(planLimit.extra['limit'])} produtos do plano gratuito` : 'A planilha passa do limite de produtos do plano'}
                    action={<Link to="/app/plano" className="btn btn--secondary btn--sm">Ver planos</Link>}
                  >
                    {typeof planLimit.extra['current'] === 'number' && <>Com ela, a empresa ficaria com {fmtInteger(planLimit.extra['current'])} produtos. </>}
                    {outcome.sent === 0 ? 'Nenhuma linha foi importada.' : `As primeiras ${fmtInteger(outcome.sent)} linhas foram importadas; as demais, não.`} Assine o plano Equipe para cadastrar sem
                    limite ou importe uma planilha menor.
                  </Notice>
                ) : failure ? (
                  <Notice tone="error" title={outcome.sent === 0 ? 'A importação não foi feita' : `A importação parou depois de ${fmtInteger(outcome.sent)} de ${fmtInteger(outcome.total)} linhas`}>
                    {errorMessage(failure)} Você pode importar o mesmo arquivo de novo: o que já entrou não é duplicado.
                  </Notice>
                ) : (
                  <Notice tone={outcome.result.errors > 0 ? 'warning' : 'success'} title={outcome.result.errors > 0 ? 'Importação concluída, com linhas recusadas' : 'Importação concluída'}>
                    {picked?.fileName}
                  </Notice>
                )}

                {outcome.sent > 0 && (
                  <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
                    <div className="stat">
                      <div className="stat__label">Produtos novos</div>
                      <div className="stat__value num">{fmtInteger(outcome.result.created)}</div>
                    </div>
                    <div className="stat">
                      <div className="stat__label">Atualizados</div>
                      <div className="stat__value num">{fmtInteger(outcome.result.updated)}</div>
                    </div>
                    <div className="stat">
                      <div className="stat__label">Sem mudança</div>
                      <div className="stat__value num">{fmtInteger(outcome.result.unchanged)}</div>
                    </div>
                    <div className="stat">
                      <div className="stat__label">Com erro</div>
                      <div className="stat__value num">{fmtInteger(outcome.result.errors)}</div>
                    </div>
                  </div>
                )}

                {errorLines.length > 0 && (
                  <div>
                    <div className="strong" style={{ marginBottom: 6 }}>Linhas que não entraram</div>
                    <div className="table-wrap card card--flush card--muted">
                      <table className="table">
                        <thead>
                          <tr>
                            <th title="Posição entre as linhas com dados da planilha, sem contar o cabeçalho">Linha</th>
                            <th>Produto</th>
                            <th>Motivo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {errorLines.slice(0, ERRORS_ON_SCREEN).map((line) => (
                            <tr key={line.index}>
                              <td className="num nowrap">{fmtInteger(line.index + 1)}ª</td>
                              <td>{line.name || <span className="faint">(sem nome)</span>}</td>
                              <td>{line.message ?? 'Linha não aceita.'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="caption" style={{ marginTop: 6 }}>
                      A posição conta só as linhas com dados, sem o cabeçalho.
                      {errorLines.length > ERRORS_ON_SCREEN && ` Mostrando as primeiras ${ERRORS_ON_SCREEN} de ${fmtInteger(errorLines.length)}.`}
                    </p>
                  </div>
                )}

                <div className="row row--end row--wrap">
                  <button type="button" className="btn btn--ghost" onClick={reset}>
                    Importar outro arquivo
                  </button>
                  {failure !== null && failure !== undefined && !planLimit && (
                    <button type="button" className="btn btn--primary" onClick={() => void run()}>
                      Tentar de novo
                    </button>
                  )}
                  <Link to="/app/estoque" className="btn btn--secondary">
                    Ver o estoque
                  </Link>
                </div>
              </div>
            )}

            <div>
              <div className="strong" style={{ marginBottom: 6 }}>Como a importação funciona</div>
              <ol className="steps">
                <li>
                  Cada linha é comparada com os produtos que já existem, nesta ordem: <strong>código interno</strong> (coluna “id”, quando a planilha tem), <strong>SKU</strong>,{' '}
                  <strong>código de barras</strong> e, por último, <strong>nome</strong>.
                </li>
                <li>
                  Produto encontrado é <strong>atualizado</strong>: só mudam as colunas preenchidas e diferentes. Coluna vazia não apaga nada.
                </li>
                <li>
                  Se a quantidade da planilha for diferente da atual, a diferença entra no histórico como um <strong>ajuste</strong>.
                </li>
                <li>
                  Produto não encontrado é <strong>cadastrado</strong>, e a quantidade vira o estoque inicial.
                </li>
              </ol>
            </div>
          </div>
        )}
      </Card>

      <Card flush title="Exportar" subtitle="Uma cópia dos dados da empresa para guardar ou abrir em outro programa">
        <div className="list">
          {can('produtos.ver') &&
            exportRow('products', 'box', 'Produtos (CSV)', 'O cadastro com quantidades e valores. Abre no Excel e pode ser importado de volta aqui.', 'Baixar')}
          {can('movimentacoes.ver') && exportRow('movements', 'history', 'Movimentações (CSV)', 'O histórico completo de entradas, saídas e ajustes.', 'Baixar')}
          {can('produtos.ver') &&
            exportRow(
              'backup',
              'layers',
              'Cópia completa (JSON)',
              can('movimentacoes.ver')
                ? 'Produtos e histórico num arquivo só, no mesmo formato da cópia de segurança do aplicativo.'
                : 'Os produtos, no mesmo formato da cópia de segurança do aplicativo. Seu acesso não inclui o histórico.',
              'Baixar',
            )}
          {!can('produtos.ver') && !can('movimentacoes.ver') && (
            <div className="list__item muted">Seu acesso não permite exportar os dados desta empresa.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
