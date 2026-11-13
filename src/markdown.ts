import { escapeHtml, safeHttpUrl } from './util.ts';

/**
 * A small dependency-free Markdown renderer for agent notes. Raw HTML in the
 * source is always escaped; links and images must pass `safeHttpUrl`.
 */
export function renderMarkdown(source: unknown): string {
  const lines = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  return renderBlocks(lines).trim();
}

export function markdownToText(source: unknown): string {
  return String(source ?? '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    .replace(/^[ \t]*\|?[\s:|-]+\|?[ \t]*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const FENCE = /^\s*(```|~~~)\s*([\w-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}\d+[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const language = fence[2];
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const close = FENCE.exec(lines[index]);
        if (close && close[1] === marker) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : '';
      out.push(`<pre><code${languageClass}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index]);
        if (!quoted) break;
        body.push(quoted[1]);
        index += 1;
      }
      out.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const pattern = ordered ? OL : UL;
      const items: string[] = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (!item) break;
        items.push(`<li>${inline(item[1].trim())}</li>`);
        index += 1;
        // A single indented continuation line belongs to the item above.
        if (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !pattern.test(lines[index])) {
          items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${inline(lines[index].trim())}</li>`);
          index += 1;
        }
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    if (line.trimStart().startsWith('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1])) {
      const header = tableCells(line);
      const alignments = tableCells(lines[index + 1]).map(cell => {
        const left = cell.trim().startsWith(':');
        const right = cell.trim().endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trimStart().startsWith('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      const head = header
        .map((cell, column) => `<th${alignStyle(alignments[column])}>${inline(cell.trim())}</th>`)
        .join('');
      const body = rows
        .map(
          cells =>
            `<tr>${header
              .map((_, column) => `<td${alignStyle(alignments[column])}>${inline((cells[column] || '').trim())}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    } else {
      // A block start we did not consume (for example a table without a
      // separator) must not loop forever.
      out.push(`<p>${inline(line.trim())}</p>`);
      index += 1;
    }
  }

  return out.join('\n');
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    Boolean(FENCE.exec(line)) ||
    Boolean(HEADING.exec(line)) ||
    HR.test(line) ||
    Boolean(QUOTE.exec(line)) ||
    Boolean(UL.exec(line)) ||
    Boolean(OL.exec(line)) ||
    (line.trimStart().startsWith('|') &&
      index + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[index + 1]))
  );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|');
}

function alignStyle(alignment: string): string {
  return alignment ? ` style="text-align:${alignment}"` : '';
}

/** Inline spans; the input is plain markdown, the output is escaped HTML. */
function inline(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index) {
        out += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (char === '!' && text[index + 1] === '[') {
      const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
      if (match) {
        const src = safeHttpUrl(match[2]);
        out += src
          ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(match[1])}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
          : escapeHtml(match[1]);
        index += match[0].length;
        continue;
      }
    }

    if (char === '[') {
      const match = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
      if (match) {
        const href = safeHttpUrl(match[2]);
        const label = inline(match[1]);
        out += href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
          : label;
        index += match[0].length;
        continue;
      }
    }

    const strong = /^(\*\*|__)([\s\S]+?)\1/.exec(text.slice(index));
    if (strong) {
      out += `<strong>${inline(strong[2])}</strong>`;
      index += strong[0].length;
      continue;
    }

    const emphasis = /^(\*|_)([^*_]+?)\1/.exec(text.slice(index));
    if (emphasis) {
      out += `<em>${inline(emphasis[2])}</em>`;
      index += emphasis[0].length;
      continue;
    }

    let end = index;
    while (end < text.length && !'`![*_'.includes(text[end])) end += 1;
    if (end === index) end += 1;
    out += escapeHtml(text.slice(index, end));
    index = end;
  }

  return out;
}
