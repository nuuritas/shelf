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
    posterUrl: null,
    posterAlt: null,
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

test('renders the view menu and unarchive action', () => {
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

  // The current cut is the trigger's only phrase, and the panel lists both.
  assert.match(html, /<details class="filter-menu view-menu">/);
  assert.match(
    html,
    /<span class="filter-name">View<\/span><span class="filter-value">Archived<span class="filter-count">1<\/span><\/span>/,
  );
  assert.match(
    html,
    /<a href="\/"><span class="filter-label">Active<\/span><span class="filter-count">4<\/span><\/a>/,
  );
  assert.match(
    html,
    /<a href="\/\?view=archived" aria-current="page"><span class="filter-label">Archived<\/span><span class="filter-count">1<\/span><\/a>/,
  );
  assert.doesNotMatch(html, /aria-label="Archive filter"/);
  assert.match(html, /class="archive-chip">Archived<\/span>/);
  assert.match(html, />Unarchive<\/button>/);
  assert.match(html, /Bookmark archived\./);
});

test('a post card keeps the source in the head and its controls in a footer', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ metrics: { replies: 12, reposts: 3, likes: 40, views: 900 } })],
    total: 1,
    query: '',
  });

  // The head is provenance only, so the outbound link sits there alone.
  const head = html.match(/<header class="card-head">[\s\S]*?<\/header>/);
  assert.match(head[0], /<a class="x-link" href="https:\/\/x\.com\/a\/status\/123"/);

  // The footer closes the card: every control is there, in one menu.
  const foot = html.match(/<div class="card-foot">[\s\S]*<\/article>/);
  assert.ok(foot, 'the card has no footer');
  assert.match(foot[0], /<button class="card-tool" type="submit">Archive<\/button>/);
  assert.match(foot[0], /<button class="card-tool danger" type="submit">Remove<\/button>/);
  assert.match(foot[0], /class="label-editor"/);
  assert.match(foot[0], /data-menu-toggle/);

  // No counts, no JSON, no second copy of either control pair.
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

test('a saved page draws the picture it came with', () => {
  const html = renderPage({
    bookmarks: [
      sampleBookmark({
        url: 'https://example.com/a-page',
        provider: 'web',
        posterUrl: 'https://example.com/art/cover.png',
        posterAlt: 'A "quoted" <cover>',
      }),
    ],
    total: 1,
    query: '',
  });

  const posters = html.match(/<figure class="card-poster">[\s\S]*?<\/figure>/g) || [];
  assert.equal(posters.length, 1);
  assert.match(posters[0], /href="https:\/\/example\.com\/a-page"/);
  assert.match(posters[0], /target="_blank"/);
  assert.match(posters[0], /rel="noopener noreferrer"/);
  assert.match(posters[0], /src="https:\/\/example\.com\/art\/cover\.png"/);
  assert.match(posters[0], /alt="A &quot;quoted&quot; &lt;cover&gt;"/);
  assert.match(posters[0], /loading="lazy"/);
  assert.match(posters[0], /referrerpolicy="no-referrer"/);
  // It sits between the copy and the rest of the card.
  const text = html.indexOf('<div class="tweet-text">');
  assert.ok(text > -1 && html.indexOf('<figure class="card-poster">') > text);
});

test('a card without a picture draws no poster', () => {
  const html = renderPage({ bookmarks: [sampleBookmark()], total: 1, query: '' });
  assert.doesNotMatch(html, /class="card-poster"/);
  assert.doesNotMatch(html, /posterUrl/);
});

test('a picture URL the renderer will not hotlink draws no poster', () => {
  for (const value of ['javascript:alert(1)', 'http://example.com/a.png', 'data:image/png;base64,AA']) {
    const html = renderPage({
      bookmarks: [sampleBookmark({ url: 'https://example.com/a-page', posterUrl: value })],
      total: 1,
      query: '',
    });
    assert.doesNotMatch(html, /class="card-poster"/, `${value} must not be drawn`);
  }
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
  assert.match(html, /Translated from the original summary\./);
});

test('a deployment outside English and Turkish names its own language', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark()],
    total: 1,
    query: '',
    view: 'active',
    lang: 'en',
    activeTotal: 1,
    archivedTotal: 0,
    bilingual: true,
    summaryLanguage: 'pt-BR',
  });

  // Neither the board switch nor the card tag may say Turkish when the primary
  // summary is Portuguese; the switch still links to `lang=tr`, which is the
  // interface language that shows the original.
  assert.doesNotMatch(html, />Türkçe</);
  assert.match(html, /class="lang-switch"[\s\S]*?>português \(Brasil\)</i);
  assert.match(html, /class="lang-tag">PT</);
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

test('a save made without an AI key says so and offers no button', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ summary: null, summaryStatus: 'needs_key' })],
    total: 1,
    query: '',
    view: 'active',
    lang: 'tr',
    activeTotal: 1,
    archivedTotal: 0,
    aiConfigured: false,
  });

  assert.match(html, /Summary not configured/);
  assert.match(html, /Bind Workers AI as AI, or add an AI_API_KEY secret/);
  assert.doesNotMatch(html, /class="summary-retry"/);
  assert.doesNotMatch(html, /Start now/);

  // A row with no stored status and no key is the same state.
  const unset = renderPage({
    bookmarks: [sampleBookmark({ summary: null, summaryStatus: null })],
    total: 1,
    query: '',
    aiConfigured: false,
  });
  assert.match(unset, /Summary not configured/);
  assert.doesNotMatch(unset, /Start now/);
});

test('a save parked while summaries are off offers to start one now', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ summary: null, summaryStatus: 'idle' })],
    total: 1,
    query: '',
    view: 'active',
    lang: 'tr',
    activeTotal: 1,
    archivedTotal: 0,
    aiConfigured: true,
  });

  assert.match(html, /Summary waiting/);
  assert.match(html, /Automatic summaries are off/);
  assert.match(html, /in Settings/);
  assert.match(html, /<form method="post" action="\/summarize" class="summary-retry">/);
  assert.match(html, /name="id" value="123"/);
  assert.match(html, /name="returnTo" value="[^"]*"/);
  assert.match(html, />Start now<\/button>/);
  assert.doesNotMatch(html, /Bind Workers AI/);
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
  assert.match(html, /value="en" selected/);
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
  assert.match(html, /value="tr" selected/);
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

  assert.match(html, /<details class="filter-menu is-set">/);
  assert.match(html, /<span class="filter-value">YouTube<\/span>/);
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

  // One form per row, each naming its own label: a pill is a submit button, so
  // the click saves and no Save button is needed.
  assert.equal(html.match(/<form class="segmented" method="post" action="\/settings\/appearance"/g)?.length, 2);
  assert.match(
    html,
    /<form class="segmented" method="post" action="\/settings\/appearance" aria-labelledby="theme-label">/,
  );
  assert.match(
    html,
    /<form class="segmented" method="post" action="\/settings\/appearance" aria-labelledby="size-label">/,
  );

  for (const theme of ['system', 'light', 'dark']) {
    assert.match(html, new RegExp(`<button type="submit" name="theme" value="${theme}"`));
  }
  for (const size of ['compact', 'normal', 'large', 'xlarge']) {
    assert.match(html, new RegExp(`<button type="submit" name="size" value="${size}"`));
  }

  // The chosen pair is pressed, the others are not, and both are buttons.
  assert.match(
    html,
    /<button type="submit" name="theme" value="dark" class="is-on" aria-pressed="true"/,
  );
  assert.match(
    html,
    /<button type="submit" name="size" value="xlarge" class="is-on" aria-pressed="true"/,
  );
  assert.match(html, /<button type="submit" name="theme" value="light" aria-pressed="false" title="[^"]*"/);
  assert.match(
    html,
    /<button type="submit" name="size" value="compact" aria-pressed="false" title="[^"]*" aria-label="Compact"/,
  );
  assert.match(html, /<html lang="en" data-theme="dark" data-size="xlarge">/);
  assert.match(html, /browser setting/);

  // Nothing is a radio any more: no group role, no checked input.
  assert.doesNotMatch(html, /role="radiogroup"/);
  assert.doesNotMatch(html, /type="radio"/);
  assert.doesNotMatch(html, /name="theme" value="[a-z]+" checked/);
  assert.doesNotMatch(html, /name="size" value="[a-z]+" checked/);
});

test('the settings page keeps one form, one Save and one Reset', () => {
  const html = renderSettings({
    settings: { summaryPrompt: 'Write in {{language}}.', summaryLanguage: 'tr' },
    ai: { provider: 'openai', model: 'gpt-4.1-mini', transport: 'http' },
    aiConfigured: true,
    pushSubscriptions: 1,
  });

  // One POST for the page: the prompt and language still share a Save, and both
  // buttons carry the same `action` field the Worker reads.
  assert.equal(html.match(/<form method="post" action="\/settings"/g)?.length, 1);
  assert.match(html, /<form method="post" action="\/settings" class="settings-form">/);
  assert.equal(html.match(/name="action" value="save"/g)?.length, 1);
  assert.equal(html.match(/name="action" value="reset"/g)?.length, 1);

  // The only other posts are the two appearance rows, which save on the click.
  assert.match(html, /\/settings\/appearance/);
  assert.equal(html.match(/action="\/settings\/appearance"/g)?.length, 2);

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
  assert.ok(appearance >= 0);
  // It still leads the page, but it is no longer a card inside the big form:
  // the card opens and closes before the form does, because each row posts on
  // its own.
  assert.ok(appearance < form);
  assert.ok(appearance < html.indexOf('name="summary_language"'));
  assert.ok(html.indexOf('</section>', appearance) < form);

  // Every card head is the same row: heading plus one state badge.
  assert.equal(html.match(/<div class="settings-card-head">/g)?.length, 6);
  assert.match(html, /class="settings-badge is-on">Türkçe|class="settings-badge is-on">English/);
  assert.match(html, /class="settings-badge is-on">Configured</);
});

test('the settings stylesheet carries the cloud rhythm', () => {
  assert.match(CSS, /\.settings \{[^}]*max-width: 1120px;[^}]*margin-inline: auto;/);
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
  // The pill is a button that saves on the click, so the checked-radio rules
  // are gone with the radio inputs.
  assert.match(CSS, /\.segmented button \{/);
  assert.match(CSS, /\.segmented button\.is-on \{/);
  assert.match(CSS, /\.segmented button:focus-visible \{/);
  assert.doesNotMatch(CSS, /\.segmented label/);
  assert.doesNotMatch(CSS, /\.segmented input/);
  assert.doesNotMatch(CSS, /\.segmented span/);
  assert.doesNotMatch(CSS, /\.segmented[^{]*:has\(input:checked\)/);
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
    posterUrl: null,
    posterAlt: null,
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

  // The row is a filter over the same shelf, not a folder tree: one menu whose
  // trigger names the pick, and a panel row marked current for it.
  assert.match(html, /<span class="filter-name">Labels<\/span><span class="filter-value">Reading<\/span>/);
  assert.match(
    html,
    /<a href="\/\?label=reading&amp;label=design&amp;menu=labels"><span class="filter-label">Design<\/span><span class="filter-count">2<\/span><\/a>/,
  );
  assert.match(
    html,
    /<a href="\/\?menu=labels" aria-current="page"><span class="filter-label">Reading<\/span><span class="filter-count">1<\/span><span class="filter-remove" aria-hidden="true">×<\/span><\/a>/,
  );
  // The selected label is the page's heading.
  assert.match(html, /<h2>Reading<\/h2>/);
  // A chip on the card opens that label's view, carrying the tone its slug
  // hashes to so the same word keeps one colour.
  assert.match(html, /<a class="label tone-\d" href="\/\?label=reading">Reading<\/a>/);
  // The editor is a tick list of the labels the page knows, not a text field,
  // and it remembers the filtered view.
  assert.match(html, /<form class="label-form" method="post" action="\/labels">/);
  assert.match(html, /name="returnTo" value="\/\?label=reading"/);
  assert.match(html, /<fieldset class="label-picks">/);
  assert.match(html, /<legend class="sr-only">Labels<\/legend>/);
  // The checkbox value is the name, because the parser derives the slug.
  assert.match(
    html,
    /<label class="label-check"><input type="checkbox" name="label" value="Design" checked><span>Design<\/span><\/label>/,
  );
  assert.match(
    html,
    /<label class="label-check"><input type="checkbox" name="label" value="Reading" checked><span>Reading<\/span><\/label>/,
  );
  // The new name is a chip in the same row, closed until it is used.
  assert.match(html, /<details class="label-new">\s*<summary>\+ New label<\/summary>/);
  assert.match(html, /name="newLabel"/);
  // Without a script the checklist needs a button of its own.
  assert.match(
    html,
    /<noscript><button type="submit" class="label-save">Save labels<\/button><\/noscript>/,
  );
  assert.doesNotMatch(html, /name="labels"/);
});

test('a card with no labels still offers the editor', () => {
  const html = renderPage({
    bookmarks: [labelledPost()],
    total: 1,
    query: '',
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
    aiConfigured: true,
  });

  assert.match(html, /<summary>\+ Label<\/summary>/);
  assert.match(html, /name="label" value="Design"><span>Design<\/span>/);
  assert.doesNotMatch(html, /value="Design" checked/);
  assert.doesNotMatch(html, /name="labels"/);
});

test('the editor offers a label the card carries but the page list does not', () => {
  const html = renderPage({
    bookmarks: [labelledPost({ labels: [{ slug: 'zeta', name: 'Zeta' }] })],
    total: 1,
    query: '',
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
    aiConfigured: true,
  });

  // An unticked box would submit as "remove", so a carried label outside the
  // page's list is added back and stays ticked.
  assert.match(html, /<input type="checkbox" name="label" value="Zeta" checked><span>Zeta<\/span>/);
  assert.match(html, /<input type="checkbox" name="label" value="Design"><span>Design<\/span>/);
  // One list, sorted by name whatever it came from.
  assert.ok(html.indexOf('value="Design"') < html.indexOf('value="Zeta"'));
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
    /<article class="card is-collapsed" id="bookmark-123" data-ref="k7f3" data-summary-status="pending" data-pending="1">/,
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

  assert.match(html, /data-ref="123" data-summary-status="working" data-pending="1">/);
});

test('a card with a queued version or translation stays pending for the poll', () => {
  // The summary is done, so a status-only check would stop the poll; the old
  // meta refresh covered the version and the English translation too.
  const version = renderPage({
    bookmarks: [sampleBookmark({ summaryStatus: 'done', versionStatus: 'pending' })],
    total: 1,
    query: '',
  });
  assert.match(version, /data-summary-status="done" data-pending="1">/);
  assert.match(version, /<noscript><meta http-equiv="refresh" content="4"><\/noscript>/);

  const translation = renderPage({
    bookmarks: [sampleBookmark({ summaryStatus: 'done', summaryEnStatus: 'working' })],
    total: 1,
    query: '',
    lang: 'en',
  });
  assert.match(translation, /data-summary-status="done" data-pending="1">/);

  // The English board is the only place the translation is shown, so it alone
  // decides whether that job keeps the card pending.
  const turkish = renderPage({
    bookmarks: [sampleBookmark({ summaryStatus: 'done', summaryEnStatus: 'working' })],
    total: 1,
    query: '',
  });
  assert.doesNotMatch(turkish, /data-pending=/);
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

  assert.match(html, /<script src="\/app\.js\?v=10" defer><\/script>/);
  assert.doesNotMatch(html, /<script src="\/app\.js" defer>/);
});

const youtubeBookmark = extra =>
  sampleBookmark({
    tweetId: 'ytdQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    provider: 'youtube',
    text: 'A song that never gives you up',
    media: [
      {
        type: 'photo',
        url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        posterUrl: null,
        width: null,
        height: null,
        altText: null,
        durationMs: null,
        variants: [],
      },
    ],
    ...extra,
  });

test('a YouTube card is a poster link until the script swaps in the player', () => {
  const html = renderPage({ bookmarks: [youtubeBookmark()], total: 1, query: '' });

  assert.match(html, /class="media-cell yt-cell"/);
  assert.match(html, /class="yt-card"/);
  assert.match(html, /data-youtube="dQw4w9WgXcQ"/);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/);
  assert.match(html, /aria-label="Play video: A song that never gives you up"/);
  // Nothing is fetched from YouTube before the tap.
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /youtube-nocookie/);
});

test('a Short draws the player in a portrait box', () => {
  const html = renderPage({
    bookmarks: [youtubeBookmark({ shorts: true })],
    total: 1,
    query: '',
  });

  assert.match(html, /class="media-cell yt-cell is-portrait"/);
});

test('a non-YouTube card frames one picture as a poster', () => {
  const html = renderPage({
    bookmarks: [sampleBookmark({ media: [youtubeBookmark().media[0]] })],
    total: 1,
    query: '',
  });

  assert.doesNotMatch(html, /class="yt-card"/);
  assert.doesNotMatch(html, /media-grid main/);
  assert.match(html, /class="card-poster"/);
  // The picture opens the saved post, like the text does, not the raw file.
  assert.match(
    html,
    /class="card-poster"><a href="https:\/\/x\.com\/a\/status\/123" target="_blank" rel="noopener noreferrer"><img src="https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg" alt="" loading="lazy" referrerpolicy="no-referrer">/,
  );
});

test('three pictures are one band counted per slide', () => {
  const html = renderPage({
    bookmarks: [
      sampleBookmark({
        media: [
          {
            type: 'photo',
            url: 'https://pbs.twimg.com/media/a.jpg',
            width: 800,
            height: 1000,
            altText: 'first',
          },
          { type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg', altText: 'second' },
          { type: 'photo', url: 'https://pbs.twimg.com/media/c.jpg', altText: 'third' },
        ],
      }),
    ],
    total: 1,
    query: '',
  });

  // The lead picture is 4:5, so the band keeps that height as it pages.
  assert.match(
    html,
    /class="media-band main" role="group" aria-label="Images" tabindex="0" style="aspect-ratio:0\.8000"/,
  );
  assert.match(html, /src="https:\/\/pbs\.twimg\.com\/media\/b\.jpg" alt="second" loading="lazy" referrerpolicy="no-referrer"/);
  assert.match(html, />1\/3<\/span>/);
  assert.match(html, />2\/3<\/span>/);
  assert.match(html, />3\/3<\/span>/);
  // Every slide opens the source post, not the image file.
  assert.equal(
    (html.match(/class="media-slide" href="https:\/\/x\.com\/a\/status\/123"/g) || []).length,
    3,
  );
  assert.doesNotMatch(html, /media-grid main/);
});

const instagramBookmark = extra =>
  sampleBookmark({
    tweetId: 'igC8xYzAbC123',
    url: 'https://www.instagram.com/p/C8xYzAbC123/',
    provider: 'instagram',
    text: 'A saved reel',
    author: { name: 'Jane Doe', username: 'jane', avatarUrl: null, verified: false },
    media: [],
    ...extra,
  });

test('an Instagram card frames the post player with the bare shortcode', () => {
  const html = renderPage({ bookmarks: [instagramBookmark()], total: 1, query: '' });

  assert.match(html, /class="card-embed"/);
  assert.match(
    html,
    /<iframe src="https:\/\/www\.instagram\.com\/p\/C8xYzAbC123\/embed\/" title="Instagram post" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer">/,
  );
  // The reader's id is `ig<code>`; the embed endpoint needs the code alone.
  assert.doesNotMatch(html, /\/p\/igC8xYzAbC123\/embed\//);
});

test('an X card never frames Instagram', () => {
  const html = renderPage({ bookmarks: [sampleBookmark()], total: 1, query: '' });

  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /instagram\.com\/p\//);
});

test('a filter link keeps every label pick, and one pick reads as it always did', () => {
  const withPicks = (picks, extra = {}) =>
    renderPage({
      bookmarks: [labelledPost()],
      total: 1,
      query: '',
      labels: [
        { slug: 'design', name: 'Design', count: 2 },
        { slug: 'reading', name: 'Reading', count: 1 },
      ],
      activeTotal: 12,
      archivedTotal: 3,
      bilingual: true,
      ...picks,
      ...extra,
    });

  const two = withPicks({ labelPicks: ['design', 'reading'] });

  // Archive, language and layout controls carry both picks, in one order.
  assert.match(two, /href="\/\?label=design&amp;label=reading"/);
  assert.match(two, /href="\/\?label=design&amp;label=reading&amp;view=archived"/);
  assert.match(two, /href="\/\?label=design&amp;label=reading&amp;lang=en"/);
  // The search form posts one hidden input per pick, so a search keeps the cut.
  assert.match(two, /<input type="hidden" name="label" value="design">/);
  assert.match(two, /<input type="hidden" name="label" value="reading">/);
  // Two picks are named in full, never as the first one of the two.
  assert.match(two, /<h2>Design, Reading<\/h2>/);
  assert.match(two, /2 labels · 12 active/);

  // A single pick renders exactly the URL it rendered before picks existed.
  const one = withPicks({ labelPicks: ['design'] });
  assert.match(one, /href="\/\?label=design"/);
  assert.match(one, /href="\/\?label=design&amp;view=archived"/);
  assert.match(one, /<h2>Design<\/h2>/);
  assert.match(one, /Label · 12 active/);
  // Nothing but the label menu's own row carries a second pick, so every link a
  // reader bookmarked still reads the same.
  assert.doesNotMatch(one, /returnTo" value="[^"]*label=design&amp;label=/);
  assert.match(one, /href="\/\?label=design&amp;label=reading&amp;menu=labels"/);

  // The single-value option still works: it fills the array, it does not fight it.
  assert.equal(withPicks({ label: 'design' }), one);
});

const FILTER_TOPICS = [
  {
    slug: 'ai',
    name: 'AI',
    description: null,
    overview: '',
    overviewAt: null,
    count: 4,
    archivedCount: 1,
  },
];

test('the filter bar is four named menus, not stacked chip rows', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    topics: FILTER_TOPICS,
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
  });

  assert.equal((html.match(/<details class="filter-menu/g) || []).length, 4);
  assert.match(html, /<div class="library-switches">\s*<details class="filter-menu view-menu">/);
  assert.match(html, /<span class="filter-name">View<\/span>/);
  assert.match(html, /<span class="filter-name">Source<\/span>/);
  assert.match(html, /<span class="filter-name">Folder<\/span>/);
  assert.match(html, /<span class="filter-name">Labels<\/span>/);
  assert.match(html, /<div class="library-bar">\s*<div class="library-switches">/);
  assert.doesNotMatch(html, /source-switch|label-switch/);
});

test('the source menu reads both picks and toggles only its own value', () => {
  const html = renderPage({ bookmarks: [], total: 0, query: '', sources: ['x', 'youtube'] });

  assert.match(
    html,
    /<details class="filter-menu is-set">\s*<summary><span class="filter-name">Source<\/span><span class="filter-value">X, YouTube<\/span>/,
  );
  // Each row is the cut without its own value, followed by the panel's key; a
  // chosen row carries the × that drops it.
  assert.match(
    html,
    /<a href="\/\?source=youtube&amp;menu=source" aria-current="page"><span class="filter-label">X<\/span><span class="filter-remove" aria-hidden="true">×<\/span><\/a>/,
  );
  assert.match(
    html,
    /<a href="\/\?source=x&amp;menu=source" aria-current="page"><span class="filter-label">YouTube<\/span><span class="filter-remove" aria-hidden="true">×<\/span><\/a>/,
  );
  // A value that was not picked joins the two, and nothing else changes.
  assert.match(
    html,
    /<a href="\/\?source=x&amp;source=youtube&amp;source=web&amp;menu=source"><span class="filter-label">Web<\/span><\/a>/,
  );
  // The menu offers every source value, the artifact included.
  assert.match(html, /<span class="filter-label">Artifact<\/span>/);
});

test('a menu pick keeps every other pick, and the menu key comes last', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: 'claude',
    topics: FILTER_TOPICS,
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
    labelPicks: ['design'],
    topicPicks: ['ai'],
    sources: ['youtube'],
    view: 'archived',
    lang: 'en',
  });

  assert.match(
    html,
    /<a href="\/\?q=claude&amp;label=design&amp;view=archived&amp;lang=en&amp;source=youtube&amp;source=x&amp;topic=ai&amp;menu=source"><span class="filter-label">X<\/span><\/a>/,
  );
  // The clear row drops one group and keeps the panel open, as the cloud does.
  assert.match(
    html,
    /<a href="\/\?q=claude&amp;label=design&amp;view=archived&amp;lang=en&amp;topic=ai&amp;menu=source">All sources<\/a>/,
  );
});

test('a chosen row drops from inside its menu, and one Clear all leaves every cut', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    topics: FILTER_TOPICS,
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
    labelPicks: ['design'],
    topicPicks: ['ai'],
    sources: ['x', 'youtube'],
  });

  // No second row of chips: a pick is announced where it was made.
  assert.doesNotMatch(html, /filter-token/);
  assert.equal((html.match(/class="filter-remove"/g) || []).length, 4);
  // The row's href is the toggle-off link, and the menu key keeps it open.
  assert.match(
    html,
    /<a href="\/\?label=design&amp;source=youtube&amp;topic=ai&amp;menu=source" aria-current="page"><span class="filter-label">X<\/span><span class="filter-remove" aria-hidden="true">×<\/span><\/a>/,
  );
  assert.match(
    html,
    /<a href="\/\?source=x&amp;source=youtube&amp;topic=ai&amp;menu=labels" aria-current="page"><span class="filter-label">Design<\/span><span class="filter-count">2<\/span><span class="filter-remove" aria-hidden="true">×<\/span><\/a>/,
  );
  // One Clear all sits at the end of the menu row.
  assert.match(html, /<a class="clear-filters" href="\/">Clear all<\/a>\s*<\/div>/);

  // Clear all returns the shelf to Active and keeps a search and a day.
  const clear = renderPage({
    bookmarks: [],
    total: 0,
    query: 'claude',
    day: '2026-11-06',
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
    labelPicks: ['design'],
    sources: ['x'],
    view: 'archived',
  });
  assert.match(
    clear,
    /<a class="clear-filters" href="\/\?q=claude&amp;day=2026-11-06">Clear all<\/a>/,
  );

  // With nothing filtered it is absent, and the archived view alone is enough.
  const none = renderPage({ bookmarks: [], total: 0, query: '', view: 'active' });
  assert.doesNotMatch(none, /class="clear-filters"/);
  const viewOnly = renderPage({ bookmarks: [], total: 0, query: '', view: 'archived' });
  assert.match(viewOnly, /<a class="clear-filters" href="\/">Clear all<\/a>/);
});

test('a chosen row shows a ×, the view a tick, and the bar sits left', () => {
  // Only View is one cut, so only it keeps the CSS tick.
  assert.match(CSS, /\.view-menu \.filter-panel a\[aria-current\]::after \{[^}]*content: '✓'/);
  assert.match(CSS, /\.filter-remove \{[^}]*color: var\(--faint\)/);
  assert.match(CSS, /\.library-switches \{[^}]*justify-content: flex-start/);
  assert.match(CSS, /\.filter-panel \{[^}]*left: 0;[^}]*right: auto/);
  // The dead chip row is gone from the stylesheet too.
  assert.doesNotMatch(CSS, /filter-tokens/);
  assert.doesNotMatch(CSS, /\.filter-token[ ,{]/);
});

test('the menu a pick came from reopens, and no other does', () => {
  const open = renderPage({ bookmarks: [], total: 0, query: '', sources: ['x'], menu: 'source' });
  assert.match(open, /<details class="filter-menu is-set" open>/);
  assert.equal((open.match(/<details class="filter-menu[^"]*" open>/g) || []).length, 1);

  const closed = renderPage({ bookmarks: [], total: 0, query: '', sources: ['x'] });
  assert.equal((closed.match(/<details class="filter-menu[^"]*" open>/g) || []).length, 0);

  // Anything but the three keys opens nothing and reaches the markup as nothing.
  const junk = renderPage({ bookmarks: [], total: 0, query: '', menu: '"><script>' });
  assert.equal((junk.match(/<details class="filter-menu[^"]*" open>/g) || []).length, 0);
  assert.doesNotMatch(junk, /<script>/);
});

test('a filter menu is a details, so it works without a script', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    labels: [{ slug: 'design', name: 'Design', count: 2 }],
  });

  assert.match(
    html,
    /<details class="filter-menu">\s*<summary><span class="filter-name">Labels<\/span><span class="filter-value">All labels<\/span><span class="caret" aria-hidden="true">▾<\/span><\/summary>/,
  );
  assert.match(
    html,
    /<div class="filter-panel">\s*<p class="filter-panel-head">Labels<\/p>\s*<a href="\/\?menu=labels" aria-current="page">All labels<\/a>/,
  );
  // A row is a plain link: no button, and no script is needed to open the panel.
  assert.match(
    html,
    /<a href="\/\?label=design&amp;menu=labels"><span class="filter-label">Design<\/span><span class="filter-count">2<\/span><\/a>/,
  );
  assert.doesNotMatch(html, /<button[^>]*>All labels/);
});

test('an empty label view names every pick it carries', () => {
  const html = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    labels: [
      { slug: 'design', name: 'Design', count: 2 },
      { slug: 'reading', name: 'Reading', count: 1 },
    ],
    labelPicks: ['design', 'reading'],
  });

  assert.match(html, /Nothing carries “Design” or “Reading”/);
  // The way out keeps both picks too.
  assert.match(html, /href="\/\?label=design&amp;label=reading&amp;view=archived"/);
});

test('a folder pick survives every link, and two folders keep both', () => {
  const topics = [
    {
      slug: 'ai',
      name: 'AI',
      description: null,
      overview: '',
      overviewAt: null,
      count: 4,
      archivedCount: 1,
    },
    {
      slug: 'design',
      name: 'Design',
      description: null,
      overview: '',
      overviewAt: null,
      count: 2,
      archivedCount: 0,
    },
  ];
  const html = renderPage({
    bookmarks: [labelledPost()],
    total: 1,
    query: '',
    topics,
    topicPicks: ['ai', 'design'],
    activeTotal: 6,
    archivedTotal: 1,
  });

  assert.match(html, /<h2>AI, Design<\/h2>/);
  assert.match(html, /2 folders · 6 active/);
  assert.match(html, /href="\/\?topic=ai&amp;topic=design"/);
  assert.match(html, /<input type="hidden" name="topic" value="ai">/);
  assert.match(html, /<input type="hidden" name="topic" value="design">/);

  // An empty cut says "folders" in the plural, not "this folder".
  const empty = renderPage({
    bookmarks: [],
    total: 0,
    query: '',
    topics,
    topicPicks: ['ai', 'design'],
  });
  assert.match(empty, /Nothing in these folders yet/);
});

