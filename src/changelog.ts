import type { UiLang } from './types.ts';
import { escapeHtml } from './util.ts';

/**
 * This Worker's changelog.
 *
 * `CHANGELOG.md` at the repository root is the only source: agents add a bullet
 * in the same pull request as the change. The Worker cannot read a file at
 * runtime, so `scripts/changelog.ts` parses that file into
 * `src/changelog-data.ts`, and a test fails when the two disagree.
 */
export type ChangelogEntry = {
  /** `YYYY-MM-DD`, as the heading in the file. */
  date: string;
  bullets: string[];
};

/**
 * The file is a deliberately small Markdown shape: a `## YYYY-MM-DD` heading
 * starts an entry, a `- ` line is a bullet, and a plain line continues the
 * bullet above it. A test pins the parser; the file stays readable by hand.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let last = -1;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (heading && heading[1]) {
      const entry: ChangelogEntry = { date: heading[1], bullets: [] };
      entries.push(entry);
      current = entry;
      last = -1;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('- ')) {
      current.bullets.push(line.slice(2).trim());
      last = current.bullets.length - 1;
      continue;
    }
    if (line && last >= 0) {
      current.bullets[last] += ` ${line}`;
    }
  }

  return entries.filter((entry) => entry.bullets.length > 0);
}

const MONTHS: Record<UiLang, string[]> = {
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  tr: [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
  ],
};

export function formatChangelogDate(date: string, lang: UiLang): string {
  const [, month, day] = date.split('-').map(Number);
  const name = MONTHS[lang][(month || 1) - 1] ?? '';
  return `${day} ${name} ${date.slice(0, 4)}`;
}

/**
 * A bullet is plain text with only two bits of Markdown: `**bold**` and a
 * `` `code` `` span. Each segment is escaped before the tag is written, so the
 * file can never inject HTML into the page.
 */
export function renderChangelogBullet(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    })
    .join('');
}

/** The newest few bullets, flat, for the Settings card. */
export function latestChangelogBullets(entries: ChangelogEntry[], count: number): string[] {
  const out: string[] = [];
  const ordered = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  for (const entry of ordered) {
    for (const bullet of entry.bullets) {
      if (out.length >= count) return out;
      out.push(bullet);
    }
  }
  return out;
}
