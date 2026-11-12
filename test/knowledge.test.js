import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPage } from '../src/render.ts';
import { slugify } from '../src/util.ts';

test('slugify folds Turkish letters into URL-safe slugs', () => {
  assert.equal(slugify('Ajan Mimarisi'), 'ajan-mimarisi');
  assert.equal(slugify('Yapay Zekâ Kodlama'), 'yapay-zeka-kodlama');
  assert.equal(slugify('Doğu Akdeniz & Ege'), 'dogu-akdeniz-ege');
  assert.equal(slugify('  '), 'topic');
});

test('renders a folder page with its synthesis and a way back to all folders', () => {
  const html = renderPage({
    bookmarks: [],
    total: 18,
    query: '',
    topics: [
      { slug: 'ajan-mimarisi', name: 'Ajan Mimarisi', count: 7, archivedCount: 0 },
      { slug: 'dogu-akdeniz', name: 'Doğu Akdeniz', count: 2, archivedCount: 0 },
    ],
    topic: {
      slug: 'ajan-mimarisi',
      name: 'Ajan Mimarisi',
      description: 'Ajanların oturum sınırlarını aşması.',
      overview: 'Birinci paragraf.\n\nİkinci paragraf.',
      count: 7,
      archivedCount: 0,
    },
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /class="folder-crumbs"/);
  assert.match(html, /← All folders/);
  assert.match(html, /<h2>Ajan Mimarisi<\/h2>/);
  assert.match(html, /Folder · 7 active/);
  assert.match(html, /Ajanların oturum sınırlarını aşması\./);
  assert.match(html, /<p>Birinci paragraf\.<\/p>/);
  assert.match(html, /<p>İkinci paragraf\.<\/p>/);
  assert.doesNotMatch(html, /class="topic-tab/);
  assert.doesNotMatch(html, /class="folder-grid"/);
});

test('renders a folder index on the home page instead of a tweet list', () => {
  const html = renderPage({
    bookmarks: [],
    total: 18,
    query: '',
    topics: [
      {
        slug: 'ajan-mimarisi',
        name: 'Ajan Mimarisi',
        description: 'Ajanların oturum sınırlarını aşması.',
        count: 7,
        archivedCount: 1,
      },
      { slug: 'dogu-akdeniz', name: 'Doğu Akdeniz', description: '', count: 2, archivedCount: 0 },
    ],
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /class="folder-grid"/);
  assert.match(html, /class="folder-card"/);
  assert.match(html, /href="\/t\/ajan-mimarisi"/);
  assert.match(html, /href="\/t\/dogu-akdeniz"/);
  assert.match(html, /class="folder-name">Ajan Mimarisi</);
  assert.match(html, /7 saves · 1 archived/);
  assert.match(html, /Browse by folder/);
  assert.doesNotMatch(html, /class="cards"/);
  assert.doesNotMatch(html, /topic-tabs/);
});

test('layout=saves keeps the flat latest-first library', () => {
  const html = renderPage({
    bookmarks: [
      {
        tweetId: '123',
        url: 'https://x.com/a/status/123',
        text: 'A saved post.',
        createdAt: '2026-11-01T10:00:00.000Z',
        savedAt: '2026-11-01T10:00:00.000Z',
        author: { name: 'A', username: 'a', avatarUrl: null, verified: false },
        media: [],
        quote: null,
        article: null,
        links: [],
        metrics: {},
        summary: 'A summary.',
        summaryStatus: 'done',
      },
    ],
    total: 1,
    query: '',
    topics: [
      { slug: 'test', name: 'Test', count: 1, archivedCount: 0 },
    ],
    layout: 'saves',
    activeTotal: 1,
    archivedTotal: 0,
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /class="cards"/);
  assert.match(html, /A saved post\./);
  assert.match(html, /All saves<span>1<\/span>/);
  assert.doesNotMatch(html, /class="folder-grid"/);
});

test('escapes topic syntheses before rendering them', () => {
  const html = renderPage({
    bookmarks: [],
    total: 1,
    query: '',
    topics: [],
    topic: {
      slug: 'test',
      name: '<script>alert(1)</script>',
      description: '',
      overview: '<img src=x onerror=alert(1)>',
      count: 1,
    },
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test('keeps the add form and long syntheses folded by default', () => {
  const long = Array.from({ length: 8 }, (_, index) => `Paragraf ${index + 1}. `.repeat(12)).join('\n\n');
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    topics: [{ slug: 'test', name: 'Test', count: 1 }],
    topic: {
      slug: 'test',
      name: 'Test',
      description: '',
      overview: long,
      count: 1,
    },
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /<details class="add-drawer">/);
  assert.match(html, /class="topic-overview is-folded"/);
  assert.match(html, /data-fold/);
  assert.match(html, /class="folder-crumbs"/);
});

test('keeps the original summary and renders new versions beside it', () => {
  const html = renderPage({
    bookmarks: [
      {
        tweetId: '123',
        url: 'https://x.com/a/status/123',
        text: 'A post worth a second angle.',
        createdAt: '2026-11-01T10:00:00.000Z',
        savedAt: '2026-11-01T10:00:00.000Z',
        author: { name: 'A', username: 'a', avatarUrl: null, verified: false },
        media: [],
        quote: null,
        article: null,
        links: [],
        metrics: {},
        summary: 'ORIGINAL SUMMARY',
        summaryStatus: 'done',
        summarizedAt: '2026-11-01T10:01:00.000Z',
        versions: [
          {
            version: 2,
            instruction: 'focus on the tradeoffs',
            summary: 'SECOND VERSION TEXT',
            createdAt: '2026-11-02T10:00:00.000Z',
          },
        ],
      },
    ],
    total: 1,
    query: '',
    topics: [],
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /ORIGINAL SUMMARY/);
  assert.match(html, /SECOND VERSION TEXT/);
  assert.match(html, /2 versions/);
  assert.match(html, /name="mode" value="version"/);
  assert.match(html, /The original summary stays as it is/);
});

test('translateSummary asks the AI for English and returns plain text', async () => {
  const { translateSummary } = await import('../src/ai.ts');
  const originalFetch = globalThis.fetch;
  let captured = null;

  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'An English explanation.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const result = await translateSummary('Türkçe bir açıklama.', {
      OPENCODE_API_KEY: 'test-key',
      AI_MODEL: 'deepseek-v4.1-flash',
    }, { session: 'shelf-20-en' });

    assert.equal(result.text, 'An English explanation.');
    assert.match(captured.url, /chat\/completions$/);
    assert.equal(captured.init.headers['x-opencode-session'], 'shelf-20-en');
    const body = JSON.parse(captured.init.body);
    assert.match(body.messages[0].content, /English/);
    assert.match(body.messages[1].content, /Türkçe bir açıklama\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
