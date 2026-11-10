import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPage } from '../src/render.ts';
import { escapeHtml, linkifyText } from '../src/util.ts';

test('escapes tweet text and links bare URLs', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const html = linkifyText('hello https://x.com/a/status/1');
  assert.match(html, /href="https:\/\/x\.com\/a\/status\/1"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('renders quote images without injecting raw tweet HTML', () => {
  const html = renderPage({
    bookmarks: [
      {
        tweetId: '123',
        url: 'https://x.com/a/status/123',
        text: '<img src=x onerror=alert(1)>',
        createdAt: '2026-10-31T15:11:54.000Z',
        savedAt: '2026-11-06T00:00:00.000Z',
        author: { name: 'A', username: 'a', avatarUrl: null, verified: false },
        media: [],
        quote: {
          tweetId: '456',
          url: 'https://x.com/b/status/456',
          text: 'quoted',
          author: { name: 'B', username: 'b' },
          media: [
            {
              type: 'photo',
              url: 'https://pbs.twimg.com/media/q1.png',
              altText: 'alt',
            },
          ],
        },
        metrics: { likes: 10 },
        summary: 'A useful summary.',
        summaryStatus: 'done',
        summaryError: null,
        summarizedAt: '2026-11-06T00:01:00.000Z',
      },
    ],
    total: 1,
    query: '',
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /https:\/\/pbs\.twimg\.com\/media\/q1\.png/);
  assert.match(html, /A useful summary\./);
  assert.match(html, /share_target|manifest\.webmanifest/);
});

function sampleBookmark(overrides = {}) {
  return {
    ref: 'k7f3',
    tweetId: '123',
    url: 'https://x.com/a/status/123',
    text: 'A saved post.',
    createdAt: '2026-10-31T15:11:54.000Z',
    savedAt: '2026-11-06T00:00:00.000Z',
    author: { name: 'A', username: 'a', avatarUrl: null, verified: false },
    media: [],
    quote: null,
    article: null,
    links: [],
    metrics: {},
    summary: 'Türkçe özet.',
    summaryStatus: 'done',
    summaryError: null,
    summarizedAt: '2026-11-06T00:01:00.000Z',
    summaryEn: null,
    summaryEnStatus: null,
    summaryEnError: null,
    summaryEnAt: null,
    archivedAt: null,
    ...overrides,
  };
}

test('renders the active/archived switch and unarchive action', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ archivedAt: '2026-11-09T00:00:00.000Z' })],
    total: 1,
    query: '',
    view: 'archived',
    lang: 'tr',
    activeTotal: 4,
    archivedTotal: 1,
    bilingual: true,
    notice: 'archived',
  });

  assert.match(html, /class="view-switch"/);
  assert.match(html, /Active<span>4<\/span>/);
  assert.match(html, /Archived<span>1<\/span>/);
  assert.match(html, /class="archive-chip">Archived<\/span>/);
  assert.match(html, />Unarchive<\/button>/);
  assert.match(html, /Bookmark archived\./);
});

test('renders the English summary board when the translation exists', () => {
  const html = renderPage({
    bookmarks: [
      sampleBookmark({
        summaryEn: 'An English explanation.',
        summaryEnStatus: 'done',
        summaryEnAt: '2026-11-06T00:02:00.000Z',
      }),
    ],
    total: 1,
    query: '',
    view: 'active',
    lang: 'en',
    activeTotal: 1,
    archivedTotal: 0,
    bilingual: true,
  });

  assert.match(html, /class="lang-switch"/);
  assert.match(html, /An English explanation\./);
  assert.doesNotMatch(html, /Türkçe özet\./);
  assert.match(html, /Translated from the Turkish summary\./);
});

test('offers to write a missing English summary', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark()],
    total: 1,
    query: '',
    view: 'active',
    lang: 'en',
    activeTotal: 1,
    archivedTotal: 0,
    missingEnglish: 1,
    bilingual: true,
    aiConfigured: true,
  });

  assert.match(html, /No English version yet\./);
  assert.match(html, /Write English summary/);
  assert.match(html, /name="mode" value="translate"/);
  assert.match(html, /1 finished summary has/);
});
