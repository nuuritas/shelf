import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCalendar, renderPage, renderSettings } from '../src/render.ts';
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
    transcripts: [],
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

test('a saved URL card does not link the note reading page', () => {
  const html = renderPage({ bookmarks: [sampleBookmark()], total: 1, query: '' });

  // Notes render their own card and `/p/:ref` rejects any other kind, so a URL
  // card must not offer a reading link that would answer 404.
  assert.doesNotMatch(html, /href="\/p\/k7f3"/);
  assert.doesNotMatch(html, />Open note</);
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

test('offers a retry when a disabled summary can be recovered', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ summary: null, summaryStatus: 'disabled' })],
    total: 1,
    query: '',
    view: 'active',
    lang: 'tr',
    activeTotal: 1,
    archivedTotal: 0,
    aiConfigured: true,
  });

  assert.match(html, /<form method="post" action="\/summarize" class="summary-retry">/);
  assert.match(html, /Try again/);
  assert.match(html, /name="returnTo" value="[^"]*"/);
  assert.doesNotMatch(html, /Bind Workers AI/);
});

test('keeps the not-configured copy while AI is still off', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ summary: null, summaryStatus: 'disabled' })],
    total: 1,
    query: '',
    view: 'active',
    lang: 'tr',
    activeTotal: 1,
    archivedTotal: 0,
    aiConfigured: false,
  });

  assert.match(html, /Bind Workers AI/);
  assert.doesNotMatch(html, /class="summary-retry"/);
});

test('renders a video transcript with language, duration, and source', () => {
  const html = renderPage({
    bookmarks: [
      sampleBookmark({
        transcripts: [
          {
            url: 'https://x.com/a/status/123',
            source: 'x',
            provider: 'workers-ai',
            lang: 'tr',
            text: 'Konuşmanın tam metni burada.',
            durationSec: 340,
            bytes: 4218793,
            status: 'done',
            error: null,
            at: '2026-11-10T20:00:00.000Z',
          },
        ],
      }),
    ],
    total: 1,
    query: '',
    view: 'active',
    lang: 'tr',
    activeTotal: 1,
    archivedTotal: 0,
  });

  assert.match(html, /<details class="transcripts">/);
  assert.match(html, /Video transcript/);
  assert.match(html, /5:40/);
  assert.match(html, /TR/);
  assert.match(html, /Whisper/);
  assert.match(html, /Konuşmanın tam metni burada\./);
});

test('renders a monthly calendar with per-day counts and day links', () => {
  const html = renderCalendar({
    calendar: {
      month: '2026-11',
      days: [
        { date: '2026-11-02', count: 1 },
        { date: '2026-11-10', count: 3 },
      ],
      total: 4,
    },
    lang: 'tr',
  });

  assert.match(html, /November 2026/);
  assert.match(html, /class="calendar-grid"/);
  assert.match(html, /href="\/\?day=2026-11-10"/);
  assert.match(html, /class="cal-count">3<\/span>/);
  assert.match(html, /4 saves/);
  assert.match(html, /This month/);
});

test('shows only one day and offers a way back to the calendar', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark()],
    total: 1,
    query: '',
    day: '2026-11-10',
    view: 'active',
    lang: 'tr',
    activeTotal: 1,
    archivedTotal: 0,
  });

  assert.match(html, /Saved on 10 Nov 2026/);
  assert.match(html, /name="day" value="2026-11-10"/);
  assert.match(html, /Clear date/);
  assert.match(html, /href="\/calendar"/);
});


test('the settings page shows a custom prompt, escapes it, and marks it custom', () => {
  const html = renderSettings({
    settings: { summaryPrompt: '</textarea><script>alert(1)</script>', summaryLanguage: 'en' },
    ai: { provider: 'custom', model: 'model-x', transport: 'http' },
    aiConfigured: true,
  });

  assert.match(html, /Settings · Shelf/);
  assert.match(html, /class="settings-badge is-custom"/);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<\/textarea><script>/);
  assert.match(html, /value="en" checked/);
  assert.match(html, /OpenAI-compatible HTTP/);
  assert.match(html, /model-x/);
  assert.match(html, /Reset prompt to default/);
});

test('the settings page shows the built-in prompt until the owner saves a custom one', () => {
  const html = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'tr' },
    ai: { provider: 'cloudflare', model: '@cf/model', transport: 'workers' },
    aiConfigured: true,
  });

  assert.match(html, /Built-in/);
  assert.doesNotMatch(html, /Reset prompt to default/);
  assert.match(html, /Write in \{\{language\}\}/);
  assert.match(html, /value="tr" checked/);
  assert.match(html, /Workers AI binding/);
  assert.match(html, /Notifications/);
  assert.match(html, /data-push/);
});

test('the settings page renders a save notice and an inline error', () => {
  const saved = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'en' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    notice: 'saved',
  });
  assert.match(saved, /Settings saved/);

  const failed = renderSettings({
    settings: { summaryPrompt: 'x'.repeat(20), summaryLanguage: 'en' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    error: 'The prompt is too long.',
  });
  assert.match(failed, /class="banner error"/);
  assert.match(failed, /The prompt is too long\./);
});


test('the notifications card shows the subscription count and controls', () => {
  const html = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'en' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    pushSubscriptions: 2,
  });

  assert.match(html, /2 browsers are subscribed\./);
  assert.match(html, /data-push-enable/);
  assert.match(html, /data-push-disable/);
  assert.match(html, /data-push-test/);
  assert.match(html, /Send a test notification/);
});

test('the empty search state keeps the selected source', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: 'claude',
    view: 'active',
    lang: 'tr',
    source: 'youtube',
  });

  assert.match(html, /class="view-switch source-switch"/);
  assert.match(html, /<a class="small-button" href="\/\?source=youtube">Clear search<\/a>/);
});

test('the empty search state keeps the folder layout', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: 'claude',
    view: 'active',
    lang: 'tr',
    layout: 'folders',
  });

  assert.match(html, /<a class="small-button" href="\/\?layout=folders">Clear search<\/a>/);
});

test('an empty folder keeps the selected source when browsing folders', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    topic: {
      slug: 'ai',
      name: 'AI',
      description: null,
      overview: '',
      overviewAt: null,
      count: 0,
      archivedCount: 0,
    },
    source: 'linkedin',
  });

  assert.match(html, /href="\/\?layout=folders&amp;source=linkedin">Browse folders<\/a>/);
});

test('the footer opens the release page instead of the asset URL', () => {
  const html = renderPage({ bookmarks: [], total: 0, query: '', view: 'active' });

  assert.match(
    html,
    /<a href="https:\/\/github\.com\/nuuritas\/shelfcloud-apk\/releases\/latest" rel="noopener">Android app<\/a>/,
  );
  assert.doesNotMatch(html, /releases\/latest\/download\/Shelf\.apk/);
});
