import assert from 'node:assert/strict';
import test from 'node:test';
import { CSS, renderCalendar, renderLogin, renderPage, renderSettings } from '../src/render.ts';
import { escapeHtml, linkifyText } from '../src/util.ts';

test('escapes tweet text and links bare URLs', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const html = linkifyText('hello https://x.com/a/status/1');
  assert.match(html, /href="https:\/\/x\.com\/a\/status\/1"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('a link prints its short address while the href keeps the whole one', () => {
  const html = linkifyText(
    'read https://example.com/2026/11/16/some-very-long-article-slug-here?utm_source=x&utm_campaign=y#frag',
  );
  assert.match(
    html,
    /href="https:\/\/example\.com\/2026\/11\/16\/some-very-long-article-slug-here\?utm_source=x&amp;utm_campaign=y#frag"/,
  );
  assert.match(html, />example\.com\/2026\/11\/16\/some-very-long-arti…<\/a>/);
  assert.doesNotMatch(html, />[^<]*[?#][^<]*<\/a>/, 'the visible text carries no query or fragment');
});

test('a link drops the scheme and a www. prefix from its visible text', () => {
  const html = linkifyText('https://www.bloomberg.com/news/articles/2026-11-16/x?access_token=abc');
  assert.match(html, />bloomberg\.com\/news\/articles\/2026-11-16\/x<\/a>/);
  assert.match(
    html,
    /href="https:\/\/www\.bloomberg\.com\/news\/articles\/2026-11-16\/x\?access_token=abc"/,
  );
});

test('a short URL keeps its whole address as the visible text', () => {
  assert.match(linkifyText('https://x.com/a/status/1'), />x\.com\/a\/status\/1<\/a>/);
});

test('the visible link text is escaped', () => {
  const html = linkifyText('https://example.com/<img> and https://example.com/a&b=c');
  assert.doesNotMatch(html, /<img>/);
  assert.match(html, />example\.com\/&lt;img&gt;<\/a>/);
  assert.match(html, />example\.com\/a&amp;b=c<\/a>/);
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

test('a post card keeps archive and remove in the head and has no footer', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ metrics: { replies: 12, reposts: 3, likes: 40, views: 900 } })],
    total: 1,
    query: '',
  });

  // The two mutations are buttons beside the source link, at the top right.
  const tools = html.match(/<div class="card-tools">[\s\S]*?<\/div>/);
  assert.ok(tools, 'the card has no control row');
  assert.match(tools[0], /<button class="card-tool" type="submit">Archive<\/button>/);
  assert.match(tools[0], /<button class="card-tool danger" type="submit">Remove<\/button>/);
  assert.match(tools[0], /<a class="x-link" href="https:\/\/x\.com\/a\/status\/123"/);

  // The bottom of the card is content only: no counts, no JSON, no repeat of
  // the source link and no second archive/remove pair.
  assert.doesNotMatch(html, /class="card-foot"/);
  assert.doesNotMatch(html, /class="metrics"/);
  assert.doesNotMatch(html, />JSON</);
  assert.doesNotMatch(html, />Open on X</);
  assert.equal((html.match(/action="\/archive"/g) || []).length, 1);
  assert.equal((html.match(/action="\/delete"/g) || []).length, 1);
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
test('the reader appearance is on the html element of every page', () => {
  const dark = renderPage({
    bookmarks: [sampleBookmark()],
    total: 1,
    query: '',
    appearance: { theme: 'dark', size: 'large' },
  });
  assert.match(dark, /<html lang="en" data-theme="dark" data-size="large">/);
  assert.match(dark, /<meta name="theme-color" content="#0d1117">/);
  assert.doesNotMatch(dark, /prefers-color-scheme/);

  const calendar = renderCalendar({
    calendar: { month: '2026-11', days: [], total: 0 },
    appearance: { theme: 'light', size: 'compact' },
  });
  assert.match(calendar, /<html lang="en" data-theme="light" data-size="compact">/);

  const login = renderLogin({ appearance: { theme: 'dark', size: 'xlarge' } });
  assert.match(login, /<html lang="en" data-theme="dark" data-size="xlarge">/);

  // No choice is a choice: the media query decides, and the default is kept.
  const system = renderPage({ bookmarks: [], total: 0, query: '' });
  assert.match(system, /<html lang="en" data-size="normal">/);
  assert.doesNotMatch(system, /data-theme=/);
  assert.match(system, /media="\(prefers-color-scheme: dark\)"/);
});

test('the settings page offers theme and text size as segmented rows', () => {
  const html = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'en' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    appearance: { theme: 'dark', size: 'xlarge' },
  });

  assert.match(html, /<section class="settings-card" id="appearance">/);
  assert.match(html, /class="settings-row"/);
  assert.match(html, /role="radiogroup" aria-labelledby="theme-label"/);
  assert.match(html, /role="radiogroup" aria-labelledby="size-label"/);

  for (const theme of ['system', 'light', 'dark']) {
    assert.match(html, new RegExp(`name="theme" value="${theme}"`));
  }
  for (const size of ['compact', 'normal', 'large', 'xlarge']) {
    assert.match(html, new RegExp(`name="size" value="${size}"`));
  }

  assert.match(html, /name="theme" value="dark" checked/);
  assert.match(html, /name="size" value="xlarge" checked/);
  assert.match(html, /<html lang="en" data-theme="dark" data-size="xlarge">/);
  assert.match(html, /browser setting/);
  // Appearance still saves through the one form the page already posted.
  assert.match(html, /<form method="post" action="\/settings" class="settings-form">/);
  assert.match(html, /name="action" value="save"/);
});

test('the settings page keeps one form, one Save and one Reset', () => {
  const html = renderSettings({
    settings: { summaryPrompt: 'Write in {{language}}.', summaryLanguage: 'tr' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    pushSubscriptions: 1,
  });

  // One POST for the page: no card grew its own endpoint, and both buttons
  // carry the same `action` field the Worker reads.
  assert.equal(html.match(/<form method="post" action="\/settings"/g)?.length, 1);
  assert.match(html, /<form method="post" action="\/settings" class="settings-form">/);
  assert.doesNotMatch(html, /action="\/settings\//);
  assert.equal(html.match(/name="action" value="save"/g)?.length, 1);
  assert.equal(html.match(/name="action" value="reset"/g)?.length, 1);

  // The hooks app.js drives are still in the markup.
  assert.match(html, /data-prompt-source/);
  assert.match(html, /data-prompt-count/);
  for (const hook of ['data-push-badge', 'data-push-state', 'data-push-detail']) {
    assert.match(html, new RegExp(hook));
  }
  assert.match(html, /data-push-enable/);
  assert.match(html, /data-push-disable/);
  assert.match(html, /data-push-test/);
});

test('the AI card shows provider, model and connection as three facts', () => {
  const html = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'en' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
  });

  const facts = html.match(/<dl class="settings-facts">[\s\S]*?<\/dl>/);
  assert.ok(facts, 'the AI card keeps one definition list');
  assert.equal(facts[0].match(/<div>/g)?.length, 3);
  assert.equal(facts[0].match(/<dt>/g)?.length, 3);
  assert.match(facts[0], /<div><dt>Provider<\/dt><dd>openai<\/dd><\/div>/);
  assert.match(facts[0], /<div><dt>Model<\/dt><dd>gpt-4\.1-mini<\/dd><\/div>/);
  assert.match(facts[0], /<div><dt>Connection<\/dt><dd>OpenAI-compatible HTTP<\/dd><\/div>/);
});

test('the Appearance card leads the settings form', () => {
  const html = renderSettings({
    settings: { summaryPrompt: '', summaryLanguage: 'en' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    appearance: { theme: 'dark', size: 'large' },
  });

  const form = html.indexOf('<form method="post" action="/settings" class="settings-form">');
  const appearance = html.indexOf('<section class="settings-card" id="appearance">');
  assert.ok(form >= 0);
  assert.equal(html.indexOf('<section class="settings-card"', form), appearance);
  assert.ok(appearance < html.indexOf('name="summary_language"'));

  // Every card head is the same row: heading plus one state badge.
  assert.equal(html.match(/<div class="settings-card-head">/g)?.length, 5);
  assert.match(html, /class="settings-badge is-on">Türkçe|class="settings-badge is-on">English/);
  assert.match(html, /class="settings-badge is-on">Configured</);
});

test('the settings stylesheet carries the cloud rhythm', () => {
  assert.match(CSS, /\.settings \{[^}]*max-width: 920px;[^}]*margin-inline: auto;/);
  assert.match(CSS, /body\.settings-page \.shell,\nbody\.settings-page \.topbar \{[^}]*min\(920px/);
  assert.match(CSS, /\.settings-form \{[^}]*gap: 11px;[^}]*margin-top: 16px;/);
  assert.match(CSS, /\.settings-card \{[^}]*padding: 16px;/);
  // A label and a control: the 96px gutter, one column under the breakpoint.
  assert.match(CSS, /\.settings-row \{[^}]*grid-template-columns: 96px minmax\(0, 1fr\);/);
  assert.match(CSS, /\.settings-facts \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  const narrow = CSS.slice(CSS.indexOf('@media (max-width: 650px)'));
  assert.match(narrow, /\.settings-row \{ grid-template-columns: 1fr; gap: 7px; \}/);
  assert.match(narrow, /\.settings-facts \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(narrow, /\.settings-card \{ padding: 16px; \}/);
});

test('the stylesheet scales from one rem root and declares no px font size', () => {
  assert.match(CSS, /html \{\s*font-size: calc\(16px \* var\(--text-scale\)\);/);
  // The four choices are rules, so no page needs an inline style.
  for (const [size, scale] of Object.entries({ compact: 0.9, normal: 1, large: 1.1, xlarge: 1.2 })) {
    assert.match(CSS, new RegExp(`:root\\[data-size="${size}"\\]\\{--text-scale:${scale}\\}`));
  }
  assert.doesNotMatch(CSS, /font-size:\s*[\d.]+px/);
  assert.match(CSS, /body \{[^}]*font-size: 1rem;/);
  assert.match(CSS, /\.segmented \{/);
  assert.match(CSS, /\.segmented label:has\(input:checked\) span \{/);
  assert.match(CSS, /\.settings-row \{/);
  assert.match(CSS, /\.settings-label \{/);
});


function labelledPost(overrides = {}) {
  return {
    ref: 'k7f3a',
    tweetId: '1985100000000000000',
    url: 'https://x.com/a/status/1985100000000000000',
    text: 'A post about design systems.',
    kind: 'post',
    format: 'text',
    title: null,
    content: null,
    agent: null,
    sourceUrl: 'https://x.com/a/status/1985100000000000000',
    createdAt: '2026-10-31T15:11:54.000Z',
    savedAt: '2026-11-06T00:00:00.000Z',
    provider: 'x',
    author: { name: 'A', username: 'a', avatarUrl: null, verified: false },
    media: [],
    quote: null,
    article: null,
    links: [],
    transcripts: [],
    metrics: {},
    summary: 'A useful summary.',
    summaryStatus: 'done',
    summaryError: null,
    summarizedAt: '2026-11-06T00:01:00.000Z',
    summaryEn: null,
    summaryEnStatus: null,
    summaryEnError: null,
    summaryEnAt: null,
    archivedAt: null,
    topics: [],
    labels: [],
    ...overrides,
  };
}

test('the library reads by label: a filter row, a heading and a card chip', () => {
  const html = renderPage({
    bookmarks: [
      labelledPost({
        labels: [
          { slug: 'design', name: 'Design' },
          { slug: 'reading', name: 'Reading' },
        ],
      }),
    ],
    total: 1,
    query: '',
    labels: [
      { slug: 'design', name: 'Design', count: 2 },
      { slug: 'reading', name: 'Reading', count: 1 },
    ],
    label: 'reading',
    aiConfigured: true,
  });

  // The row is a filter over the same shelf, not a folder tree.
  assert.match(html, /<nav class="view-switch label-switch" role="group" aria-label="Label filter">/);
  assert.match(html, /href="\/\?label=design">Design<span>2<\/span>/);
  assert.match(html, /class="active" href="\/\?label=reading">Reading<span>1<\/span>/);
  // The selected label is the page's heading.
  assert.match(html, /<h2>Reading<\/h2>/);
  // A chip on the card opens that label's view, carrying the tone its slug
  // hashes to so the same word keeps one colour.
  assert.match(html, /<a class="label tone-\d" href="\/\?label=reading">Reading<\/a>/);
  // The editor rewrites the whole set and remembers the filtered view.
  assert.match(html, /<form class="label-form" method="post" action="\/labels">/);
  assert.match(html, /name="labels" value="Design, Reading"/);
  assert.match(html, /name="returnTo" value="\/\?label=reading"/);
});

test('a card with no labels still offers the editor', () => {
  const html = renderPage({
    bookmarks: [labelledPost()],
    total: 1,
    query: '',
    aiConfigured: true,
  });

  assert.match(html, /<summary>\+ Label<\/summary>/);
  assert.match(html, /name="labels" value=""/);
});

test('a label name is escaped where it is shown', () => {
  const html = renderPage({
    bookmarks: [
      labelledPost({ labels: [{ slug: 'x', name: '<img src=x onerror=alert(1)>' }] }),
    ],
    total: 1,
    query: '',
    labels: [{ slug: 'x', name: '<img src=x onerror=alert(1)>', count: 1 }],
    label: 'x',
    aiConfigured: true,
  });

  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the label styles read from tokens and stay off the page style attribute', () => {
  assert.match(CSS, /\.card-labels \{[^}]*display: flex;/);
  assert.match(CSS, /\.label \{[^}]*border: 1px solid var\(--line\);/);
  assert.match(CSS, /\.label-form button \{[^}]*font-weight: 650;/);
});

function noteCard(overrides = {}) {
  return labelledPost({
    ref: 'n7t3a',
    tweetId: '1985200000000000000',
    url: 'https://www.bloomberg.com/news/articles/2026-11-16/x',
    text: 'The note body, which the card does not print.',
    kind: 'note',
    format: 'markdown',
    title: 'A filed artifact',
    content: '# A filed artifact\n\nThe body.',
    agent: { name: 'Claude Code', model: 'claude-sonnet-4-5', tool: 'shelf' },
    sourceUrl: 'https://www.bloomberg.com/news/articles/2026-11-16/x',
    provider: 'note',
    summary: 'The abstract.',
    ...overrides,
  });
}

test('a post card carries the ref and summary status the poll swaps on', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ summaryStatus: 'pending', summary: null })],
    total: 1,
    query: '',
  });

  assert.match(
    html,
    /<article class="card is-collapsed" id="bookmark-123" data-ref="k7f3" data-summary-status="pending">/,
  );
});

test('a note card carries the ref and summary status the poll swaps on', () => {
  const html = renderPage({ bookmarks: [noteCard()], total: 1, query: '' });

  assert.match(
    html,
    /<article class="card note-card" id="bookmark-1985200000000000000" data-ref="n7t3a" data-summary-status="done">/,
  );
});

test('a card without a ref falls back to its tweet id', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ ref: '', summaryStatus: 'working', summary: null })],
    total: 1,
    query: '',
  });

  assert.match(html, /data-ref="123" data-summary-status="working">/);
});

test('a pending summary refreshes only without JavaScript', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ summaryStatus: 'pending', summary: null })],
    total: 1,
    query: '',
  });

  assert.match(html, /<noscript><meta http-equiv="refresh" content="4"><\/noscript>/);
  // The bare tag would reload the page under the running poll; the only one on
  // the page has to be the <noscript> fallback.
  assert.doesNotMatch(
    html.replace('<noscript><meta http-equiv="refresh" content="4"></noscript>', ''),
    /http-equiv="refresh"/,
  );
});

test('a finished library asks for no refresh at all', () => {
  const html = renderPage({ bookmarks: [sampleBookmark()], total: 1, query: '' });

  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /<noscript><meta/);
});

test('the page loads the poll script with a cache buster', () => {
  const html = renderPage({ bookmarks: [], total: 0, query: '' });

  assert.match(html, /<script src="\/app\.js\?v=1" defer><\/script>/);
  assert.doesNotMatch(html, /<script src="\/app\.js" defer>/);
});

