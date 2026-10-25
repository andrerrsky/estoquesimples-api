/**
 * Markdown do blog → HTML seguro.
 *
 * Um conversor pequeno e previsível, em vez de uma biblioteca: o blog usa um
 * subconjunto (títulos, parágrafos, listas, negrito, itálico, links, citação,
 * imagem, código) e o HTML de saída precisa ser exatamente o que a web, o
 * app Android (`Html.fromHtml`) e os buscadores entendem. Todo texto passa
 * por escape antes de qualquer marcação; só as tags daqui saem, e links só
 * para http(s) ou caminhos do próprio site.
 */

/**
 * Começo de um post exclusivo para o site público: a abertura e a primeira
 * seção inteira (até o segundo "h2"), no máximo 40% dos blocos. O corte é
 * entre blocos (parágrafo, lista, título...), nunca no meio de uma tag.
 */
export function previewHtml(html: string): string {
  const blocks = html.match(/<(h2|h3|p|ul|ol|blockquote|pre|hr|div)\b[\s\S]*?(?:<\/\1>|(?<=<hr>))/g) ?? [];
  if (blocks.length === 0) return html.slice(0, 1200);
  const limit = Math.max(1, Math.floor(blocks.length * 0.4));
  const kept: string[] = [];
  let h2Seen = 0;
  for (const block of blocks) {
    if (/^<h2\b/.test(block)) {
      h2Seen += 1;
      if (h2Seen >= 2) break;
    }
    kept.push(block);
    if (kept.length >= limit && h2Seen >= 1) break;
  }
  return kept.join('\n');
}

export interface RenderedMarkdown {
  html: string;
  /** Títulos (h2/h3) com id, para o sumário e os links âncora. */
  headings: Array<{ level: 2 | 3; id: string; text: string }>;
  words: number;
  plainText: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "Como organizar o estoque" → "como-organizar-o-estoque" */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^\/(?!\/)/.test(url)) return url; // caminho do site
  if (/^#[\w-]+$/.test(url)) return url; // âncora
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).href;
    } catch {
      return null;
    }
  }
  return null;
}

function anchor(href: string, label: string): string {
  const external = /^https?:\/\//i.test(href) && !href.startsWith('https://estoquesimples.com.br');
  return external ? `<a href="${escapeHtml(href)}" rel="noopener nofollow" target="_blank">${label}</a>` : `<a href="${escapeHtml(href)}">${label}</a>`;
}

/** Marcação dentro de uma linha: código, imagem, link, negrito, itálico. O texto já chega escapado. */
function inline(escaped: string): string {
  let out = escaped;
  // Código: o conteúdo não recebe mais marcação, por isso sai primeiro, guardado.
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, src: string) => {
    const href = safeHref(src);
    return href ? `<img src="${escapeHtml(href)}" alt="${alt}" loading="lazy" decoding="async">` : alt;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, src: string) => {
    const href = safeHref(src);
    return href ? anchor(href, label) : label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const headings: RenderedMarkdown['headings'] = [];
  const plain: string[] = [];
  const usedIds = new Set<string>();
  let i = 0;

  const headingId = (text: string): string => {
    const base = slugify(text) || 'secao';
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  const paragraphBuffer: string[] = [];
  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join(' ').trim();
    paragraphBuffer.length = 0;
    if (!text) return;
    plain.push(text);
    html.push(`<p>${inline(escapeHtml(text))}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      i += 1;
      continue;
    }

    // Bloco de código
    if (/^```/.test(trimmed)) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      // O título do post é o h1 da página: no corpo, "#" vira h2, "##" h2, "###" h3.
      const level: 2 | 3 = (heading[1] ?? '').length >= 3 ? 3 : 2;
      const text = (heading[2] ?? '').replace(/\*\*/g, '');
      const id = headingId(text);
      headings.push({ level, id, text });
      plain.push(text);
      html.push(`<h${level} id="${id}">${inline(escapeHtml(text))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      html.push('<hr>');
      i += 1;
      continue;
    }

    // Tabela (GFM): linha de cabeçalho com "|", linha separadora "|---|---|" e as linhas de dados.
    const nextTrimmed = (lines[i + 1] ?? '').trim();
    if (/^\|.*\|$/.test(trimmed) && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(nextTrimmed)) {
      flushParagraph();
      // "\|" é um pipe dentro da célula; célula a mais vai junto da última em vez de sumir.
      const cells = (row: string, width = 0) => {
        const parts = row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
        if (width > 0 && parts.length > width) return [...parts.slice(0, width - 1), parts.slice(width - 1).join(' | ')];
        return parts;
      };
      const header = cells(trimmed);
      const aligns = cells(nextTrimmed).map((spec) => (/^:-+:$/.test(spec) ? 'center' : /-+:$/.test(spec) ? 'right' : null));
      const cell = (tag: 'th' | 'td', text: string, index: number) => `<${tag}${aligns[index] ? ` class="ta-${aligns[index]}"` : ''}>${inline(escapeHtml(text))}</${tag}>`;
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test((lines[i] ?? '').trim())) {
        const data = cells((lines[i] ?? '').trim(), header.length);
        plain.push(data.join(' '));
        rows.push(`<tr>${header.map((_h, index) => cell('td', data[index] ?? '', index)).join('')}</tr>`);
        i += 1;
      }
      plain.push(header.join(' '));
      html.push(`<div class="table-wrap"><table><thead><tr>${header.map((text, index) => cell('th', text, index)).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test((lines[i] ?? '').trim())) {
        quote.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      const text = quote.join(' ').trim();
      plain.push(text);
      html.push(`<blockquote><p>${inline(escapeHtml(text))}</p></blockquote>`);
      continue;
    }

    const listItem = /^([-*+]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[1] ?? '');
      const items: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? '').trim();
        const match = /^([-*+]|\d+[.)])\s+(.+)$/.exec(current);
        if (match && /^\d/.test(match[1] ?? '') === ordered) {
          items.push(match[2] ?? '');
          i += 1;
          // Continuação do item (linha indentada).
          while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? '') && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i] ?? '')) {
            items[items.length - 1] += ` ${(lines[i] ?? '').trim()}`;
            i += 1;
          }
        } else break;
      }
      items.forEach((item) => plain.push(item));
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    paragraphBuffer.push(trimmed);
    i += 1;
  }
  flushParagraph();

  const plainText = plain.join('\n');
  const words = plainText.split(/\s+/).filter(Boolean).length;
  return { html: html.join('\n'), headings, words, plainText };
}

/** Leitura a ~200 palavras por minuto, nunca menos de 1. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 200));
}
