import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatChangelogDate,
  latestChangelogBullets,
  parseChangelog,
  renderChangelogBullet,
} from '../src/changelog.ts';
import { renderChangelogPage, renderSettings } from '../src/render.ts';
import { renderChangelogData } from '../scripts/changelog.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the parser reads dated headings, bullets and a continuation line', () => {
  const entries = parseChangelog(`# Changelog

An introduction is not an entry.

## 2026-11-17

- A first bullet.
- A second bullet,
  continued on the next line.

## 2026-11-16
- An older bullet.
`);
  assert.deepEqual(entries, [
    { date: '2026-11-17', bullets: ['A first bullet.', 'A second bullet, continued on the next line.'] },
    { date: '2026-11-16', bullets: ['An older bullet.'] },
  ]);
});

test('an entry with no bullets is dropped, and CRLF line endings parse the same', () => {
  assert.deepEqual(parseChangelog('## 2026-11-17\n\n## 2026-11-16\n- one\n'), [
    { date: '2026-11-16', bullets: ['one'] },
  ]);
  assert.deepEqual(parseChangelog('## 2026-11-17\r\n\r\n- one\r\n- two\r\n'), [
    { date: '2026-11-17', bullets: ['one', 'two'] },
  ]);
});

test('a date is written in the interface language', () => {
  assert.equal(formatChangelogDate('2026-11-17', 'en'), '17 November 2026');
  assert.equal(formatChangelogDate('2026-11-17', 'tr'), '17 Kasım 2026');
});

test('the generated data module agrees with CHANGELOG.md byte for byte', async () => {
  const markdown = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const expected = renderChangelogData(parseChangelog(markdown));
  const actual = await readFile(join(ROOT, 'src', 'changelog-data.ts'), 'utf8');
  assert.equal(actual, expected, 'CHANGELOG.md changed; run `bun run changelog` and commit src/changelog-data.ts');
});

test('the page renders every bullet, newest entry first, and escapes HTML', () => {
  const entries = parseChangelog(`## 2026-11-17
- **Bold** and \`code\`.
- <script>alert(1)</script>

## 2026-11-16
- An older change.
`);
  const html = renderChangelogPage({ entries, lang: 'en' });
  assert.match(html, /<article class="release">/g);
  assert.equal((html.match(/<article class="release">/g) || []).length, 2);
  assert.match(html, /<time datetime="2026-11-17">17 November 2026<\/time>/);
  assert.match(html, /<strong>Bold<\/strong> and <code>code<\/code>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.ok(html.indexOf('17 November 2026') < html.indexOf('16 November 2026'), 'newest first');
  assert.match(html, /An older change\./);
});

test('an empty changelog is an empty state, not a broken page', () => {
  const html = renderChangelogPage({ entries: [], lang: 'en' });
  assert.match(html, /Nothing is published yet\./);
  assert.doesNotMatch(html, /class="release"/);
});

test('the Settings card shows at most three bullets and links to /changelog', async () => {
  const markdown = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const entries = parseChangelog(markdown);
  const newest = latestChangelogBullets(entries, 3);
  assert.equal(newest.length, 3);

  const html = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'en', workspaceName: '', summariesEnabled: true },
    ai: { provider: 'custom', model: 'model-x', transport: 'http' },
    aiConfigured: true,
    lang: 'en',
  });
  const card = html.slice(html.indexOf("What's new"));
  assert.ok(card.length > 0, "the What's new card renders");
  assert.match(card, /href="\/changelog"/);
  assert.equal((card.match(/<li>/g) || []).length, 3);
  const plain = card.replace(/<[^>]+>/g, '');
  for (const bullet of newest) {
    const text = renderChangelogBullet(bullet).replace(/<[^>]+>/g, '');
    assert.ok(plain.includes(text), `the card carries: ${text}`);
  }
});
