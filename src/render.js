import {
  escapeHtml,
  formatCount,
  formatDate,
  linkifyText,
  safeHttpUrl,
  truncate,
} from './util.js';

const NOTICES = {
  shared: 'Saved from the Android share sheet.',
  added: 'Saved. The summary is running in the background.',
  exists: 'Already saved. The post has been refreshed.',
  deleted: 'Bookmark removed.',
  queued: 'Summary queued again.',
};

export function renderPage({
  bookmarks,
  total,
  query,
  topics = [],
  topic = null,
  notice,
  error,
  aiConfigured,
}) {
  const pending = bookmarks.some(bookmark =>
    ['pending', 'working'].includes(bookmark.summaryStatus),
  );
  const noticeText = notice ? NOTICES[notice] : '';
  const addValue = escapeHtml(query || '');

  const topicChips = topics
    .map(
      entry => `
        <a class="topic-chip ${topic?.slug === entry.slug ? 'active' : ''}" href="/t/${escapeHtml(entry.slug)}">
          ${escapeHtml(entry.name)} <span>${entry.count}</span>
        </a>
      `,
    )
    .join('');

  return pageShell({
    title: topic ? `${topic.name} · X Bookmark Vault` : 'X Bookmark Vault',
    bodyClass: 'home',
    head: pending ? '<meta http-equiv="refresh" content="4">' : '',
    body: `
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark">X</span>
          <span>Bookmark Vault</span>
        </a>
        <div class="top-actions">
          <span class="count">${total} saved</span>
          <form method="post" action="/logout">
            <button class="link-button" type="submit">Log out</button>
          </form>
        </div>
      </header>

      <main class="shell">
        <nav class="topic-bar" aria-label="Topics">
          <a class="topic-chip all ${topic ? '' : 'active'}" href="/">All <span>${total}</span></a>
          ${topicChips}
        </nav>

        ${
          topic
            ? `
          <section class="topic-hero">
            <p class="eyebrow">Topic · ${topic.count} saved</p>
            <h1>${escapeHtml(topic.name)}</h1>
            ${topic.description ? `<p class="topic-description">${escapeHtml(topic.description)}</p>` : ''}
            ${
              topic.overview
                ? `<div class="topic-overview">${renderParagraphs(topic.overview)}</div>`
                : `<p class="topic-overview-empty">The synthesis for this thread is still being written.</p>`
            }
          </section>
        `
            : `
          <section class="hero">
            <p class="eyebrow">X → your own quiet library</p>
            <h1>Keep the posts<br>worth rereading.</h1>
            <p class="lede">Share a link from X, or paste one here. The post, its quote, and its images are saved and summarized automatically.</p>

            <form class="add-form" method="post" action="/add">
              <label class="sr-only" for="url">X post URL</label>
              <input id="url" name="url" type="url" inputmode="url" autocomplete="off" placeholder="https://x.com/user/status/…" required value="${addValue}">
              <button type="submit">Save post</button>
            </form>
            <p class="fine-print">On Android, install this page once, then use <strong>Share → Bookmark Vault</strong> in X.</p>
          </section>
        `
        }

        ${noticeText ? `<div class="banner success">${escapeHtml(noticeText)}</div>` : ''}
        ${error ? `<div class="banner error">${escapeHtml(truncate(error, 400))}</div>` : ''}

        <section class="library">
          <div class="library-head">
            <div>
              <p class="eyebrow">${topic ? 'Collected here' : 'Library'}</p>
              <h2>${
                query
                  ? `Results for “${escapeHtml(query)}”`
                  : topic
                    ? 'Everything in this thread'
                    : 'Latest saves'
              }</h2>
            </div>
            ${
              topic
                ? '<a class="clear-search" href="/">← All saves</a>'
                : `
            <form class="search-form" method="get" action="/">
              <label class="sr-only" for="q">Search bookmarks</label>
              <input id="q" name="q" type="search" placeholder="Search text or author" value="${escapeHtml(query || '')}">
              <button type="submit">Search</button>
              ${query ? '<a class="clear-search" href="/">Clear</a>' : ''}
            </form>`
            }
          </div>

          ${
            bookmarks.length
              ? `<div class="cards">${bookmarks.map(bookmark => renderBookmark(bookmark, aiConfigured)).join('')}</div>`
              : renderEmpty(query)
          }

          ${
            total > bookmarks.length
              ? `<p class="paging-note">Showing ${bookmarks.length} of ${total}. Narrow the search to find older saves.</p>`
              : ''
          }
        </section>
      </main>

      <footer class="footer shell">
        <span>Read via FxTwitter</span>
        <span class="dot">·</span>
        <span>Summaries by OpenCode</span>
        <span class="dot">·</span>
        <a href="/BookmarkShare.apk">Android share app</a>
      </footer>
    `,
  });
}

function renderParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
}

function renderBookmark(bookmark, aiConfigured) {
  const author = bookmark.author ?? {};
  const handle = author.username ? `@${author.username}` : 'unknown';
  const avatar = safeHttpUrl(author.avatarUrl);
  const initial = escapeHtml((author.name || author.username || '?').slice(0, 1).toUpperCase());

  return `
    <article class="card" id="bookmark-${escapeHtml(bookmark.tweetId)}">
      <header class="card-head">
        <div class="author">
          ${
            avatar
              ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
              : `<span class="avatar avatar-fallback">${initial}</span>`
          }
          <div class="author-text">
            <div class="author-line">
              <strong>${escapeHtml(author.name || handle)}</strong>
              ${author.verified ? '<span class="verified" title="Verified">✓</span>' : ''}
              <span class="handle">${escapeHtml(handle)}</span>
            </div>
            <div class="meta">${escapeHtml(formatDate(bookmark.createdAt))}</div>
          </div>
        </div>
        <a class="x-link" href="${escapeHtml(safeHttpUrl(bookmark.url) || '#')}" target="_blank" rel="noopener noreferrer" aria-label="Open on X">X ↗</a>
      </header>

      <div class="tweet-text">${linkifyText(bookmark.text)}</div>

      ${
        bookmark.topics?.length
          ? `<div class="card-topics">${bookmark.topics
              .map(
                entry =>
                  `<a class="card-topic" href="/t/${escapeHtml(entry.slug)}">${escapeHtml(entry.name)}</a>`,
              )
              .join('')}</div>`
          : ''
      }

      ${bookmark.article ? renderArticle(bookmark.article) : ''}
      ${renderMedia(bookmark.media, 'main')}
      ${bookmark.quote ? renderQuote(bookmark.quote) : ''}
      ${bookmark.links?.length ? renderLinks(bookmark.links) : ''}
      ${renderSummary(bookmark, aiConfigured)}

      <footer class="card-foot">
        <div class="metrics">${renderMetrics(bookmark.metrics)}</div>
        <div class="card-actions">
          <a href="/api/bookmarks/${escapeHtml(bookmark.tweetId)}" target="_blank" rel="noopener">JSON</a>
          <span class="dot">·</span>
          <a href="${escapeHtml(safeHttpUrl(bookmark.url) || '#')}" target="_blank" rel="noopener noreferrer">Open on X</a>
          <span class="dot">·</span>
          <form method="post" action="/delete" class="inline-form">
            <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
            <button class="link-button danger" type="submit">Remove</button>
          </form>
        </div>
      </footer>
    </article>
  `;
}

function renderQuote(quote) {
  const author = quote.author ?? {};
  const handle = author.username ? `@${author.username}` : 'quoted post';
  return `
    <blockquote class="quote">
      <div class="quote-head">
        <span class="quote-label">Quoted post</span>
        <span class="quote-author">${escapeHtml(author.name || handle)} <span>${escapeHtml(handle)}</span></span>
      </div>
      <div class="quote-text">${linkifyText(quote.text)}</div>
      ${renderMedia(quote.media, 'quote')}
    </blockquote>
  `;
}

function renderArticle(article) {
  const url = safeHttpUrl(article.url);
  const title = article.title || 'X Article';
  return `
    <section class="linked-article">
      <div class="linked-article-head">
        <span class="quote-label">X Article</span>
        ${url ? `<a class="article-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}
      </div>
      <h3>${escapeHtml(title)}</h3>
      ${article.previewText ? `<p>${escapeHtml(truncate(article.previewText, 320))}</p>` : ''}
      <span class="article-note">Full article text was read for the summary.</span>
    </section>
  `;
}

function renderLinks(links) {
  const cards = links
    .map(link => {
      const url = safeHttpUrl(link.finalUrl || link.url);
      if (!url) return '';
      const kind = link.kind === 'github' ? 'GitHub' : 'Web';
      let host = '';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        host = '';
      }

      return `
        <a class="link-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <span class="link-kind">${kind}</span>
          <span class="link-card-body">
            <strong>${escapeHtml(link.title || host || 'Linked page')}</strong>
            ${link.description ? `<span class="link-description">${escapeHtml(truncate(link.description, 220))}</span>` : ''}
            <span class="link-host">${escapeHtml(host)}${link.error ? ' · could not be read' : ''}</span>
          </span>
          <span class="link-arrow">↗</span>
        </a>
      `;
    })
    .filter(Boolean)
    .join('');

  if (!cards) return '';
  return `<div class="link-stack">${cards}</div>`;
}

function renderMedia(media, context) {
  if (!Array.isArray(media) || media.length === 0) return '';

  const cells = media
    .map(item => {
      const url = safeHttpUrl(item.url);
      if (!url) return '';
      const alt = escapeHtml(item.altText || '');
      const poster = safeHttpUrl(item.posterUrl);

      if (item.type === 'video' || item.type === 'gif') {
        return `
          <figure class="media-cell video-cell">
            <video controls preload="metadata" playsinline ${poster ? `poster="${escapeHtml(poster)}"` : ''}>
              <source src="${escapeHtml(url)}" type="video/mp4">
            </video>
          </figure>
        `;
      }

      return `
        <figure class="media-cell">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
            <img src="${escapeHtml(url)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">
          </a>
        </figure>
      `;
    })
    .filter(Boolean)
    .join('');

  if (!cells) return '';

  return `<div class="media-grid ${context} media-count-${media.length}">${cells}</div>`;
}

function renderSummary(bookmark, aiConfigured) {
  const status = bookmark.summaryStatus || (aiConfigured ? 'pending' : 'disabled');

  if (status === 'done' && bookmark.summary) {
    return `
      <section class="summary">
        <div class="summary-head">
          <span class="summary-mark">AI</span>
          <h3>Summary</h3>
          <span class="summary-time">${escapeHtml(formatDate(bookmark.summarizedAt))}</span>
        </div>
        <div class="summary-text">${linkifyText(bookmark.summary)}</div>
        <form method="post" action="/summarize" class="summary-retry">
          <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
          <button class="link-button" type="submit">Summarize again</button>
        </form>
      </section>
    `;
  }

  if (status === 'pending' || status === 'working') {
    return `
      <section class="summary pending">
        <div class="summary-head">
          <span class="summary-mark">AI</span>
          <h3>Reading the post${bookmark.quote ? ' and quote' : ''}…</h3>
        </div>
        <div class="pulse-line"><span></span><span></span><span></span></div>
        <p class="summary-note">Text and images are being summarized. This page refreshes automatically.</p>
      </section>
    `;
  }

  if (status === 'failed') {
    return `
      <section class="summary failed">
        <div class="summary-head">
          <span class="summary-mark">AI</span>
          <h3>Summary failed</h3>
        </div>
        <p class="summary-note">${escapeHtml(truncate(bookmark.summaryError || 'The AI request failed.', 300))}</p>
        <form method="post" action="/summarize" class="summary-retry">
          <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
          <button class="small-button" type="submit">Try again</button>
        </form>
      </section>
    `;
  }

  return `
    <section class="summary disabled">
      <div class="summary-head">
        <span class="summary-mark">AI</span>
        <h3>Summary not configured</h3>
      </div>
      <p class="summary-note">Add the OPENCODE_API_KEY secret to turn on automatic summaries.</p>
    </section>
  `;
}

function renderMetrics(metrics = {}) {
  const items = [
    ['replies', metrics.replies],
    ['reposts', metrics.reposts],
    ['likes', metrics.likes],
    ['views', metrics.views],
  ]
    .map(([label, value]) => {
      const formatted = formatCount(value);
      return formatted ? `<span><strong>${formatted}</strong> ${label}</span>` : '';
    })
    .filter(Boolean);

  return items.join('<span class="dot">·</span>');
}

function renderEmpty(query) {
  if (query) {
    return `
      <div class="empty">
        <p class="empty-mark">∅</p>
        <h3>No matches</h3>
        <p>Nothing in the library matches “${escapeHtml(query)}”.</p>
        <a class="small-button" href="/">Clear search</a>
      </div>
    `;
  }

  return `
    <div class="empty">
      <p class="empty-mark">↘</p>
      <h3>Nothing saved yet</h3>
      <p>Share an X post to this app, or paste a link above. The first save takes a few seconds.</p>
    </div>
  `;
}

export function renderLogin({ error, next } = {}) {
  return pageShell({
    title: 'Log in · X Bookmark Vault',
    bodyClass: 'login-page',
    head: '',
    body: `
      <main class="login-wrap">
        <div class="login-card">
          <span class="brand-mark large">X</span>
          <p class="eyebrow">Private library</p>
          <h1>Bookmark Vault</h1>
          <p class="lede">Enter the password to open your saved posts.</p>
          ${error ? `<div class="banner error">${escapeHtml(error)}</div>` : ''}
          <form method="post" action="/login" class="login-form">
            <input type="hidden" name="next" value="${escapeHtml(next || '/')}">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
            <button type="submit">Open library</button>
          </form>
        </div>
      </main>
    `,
  });
}

export function renderSetup() {
  return pageShell({
    title: 'Setup required',
    bodyClass: 'login-page',
    head: '',
    body: `
      <main class="login-wrap">
        <div class="login-card setup-card">
          <span class="brand-mark large">X</span>
          <p class="eyebrow">One more step</p>
          <h1>Set a password</h1>
          <p class="lede">This app is locked until an <code>APP_PASSWORD</code> secret is set.</p>
          <pre>wrangler secret put APP_PASSWORD</pre>
          <p class="fine-print">Then reload this page.</p>
        </div>
      </main>
    `,
  });
}

function pageShell({ title, bodyClass, head, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f4f0e8">
  <meta name="description" content="A private, self-hosted reader for X posts, quotes, and images.">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <title>${escapeHtml(title)}</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="stylesheet" href="/style.css">
  ${head}
  <script src="/app.js" defer></script>
</head>
<body class="${escapeHtml(bodyClass)}">
  ${body}
</body>
</html>`;
}

export const CSS = `:root {
  color-scheme: light dark;
  --bg: #f4f0e8;
  --surface: #fffdf8;
  --surface-soft: #f8f3ea;
  --ink: #1c1a17;
  --muted: #726b61;
  --faint: #9b9286;
  --line: #e3dbcf;
  --line-strong: #d2c7b7;
  --accent: #c24a22;
  --accent-ink: #7f2e15;
  --accent-soft: #f7e2d8;
  --green: #2f6f4f;
  --green-soft: #e6f1e9;
  --red: #9f2f28;
  --red-soft: #f7e4e1;
  --shadow: 0 18px 50px rgba(45, 36, 24, 0.07);
  --radius: 22px;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141311;
    --surface: #1d1b18;
    --surface-soft: #24211d;
    --ink: #f3ede3;
    --muted: #b6ac9f;
    --faint: #81786d;
    --line: #332f29;
    --line-strong: #484138;
    --accent: #e77a4f;
    --accent-ink: #ffb08f;
    --accent-soft: #3a241b;
    --green: #8bc7a5;
    --green-soft: #1d2f25;
    --red: #f09b91;
    --red-soft: #351f1d;
    --shadow: 0 22px 60px rgba(0, 0, 0, 0.28);
  }
}

* { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow-x: clip;
}

a { color: inherit; }

button, input { font: inherit; }

button { cursor: pointer; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.shell {
  width: min(820px, calc(100% - 36px));
  margin-inline: auto;
}

.topbar {
  width: min(900px, calc(100% - 36px));
  margin-inline: auto;
  padding: 26px 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--ink);
  color: var(--bg);
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}

.brand-mark.large {
  width: 54px;
  height: 54px;
  border-radius: 17px;
  font-size: 27px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--muted);
  font-size: 13px;
}

.count {
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}

.hero {
  padding: 84px 0 54px;
}

.eyebrow {
  margin: 0 0 12px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1, h2, h3, p { margin-top: 0; }

.hero h1 {
  margin-bottom: 20px;
  font-size: clamp(42px, 8vw, 76px);
  line-height: 0.98;
  letter-spacing: -0.055em;
  font-weight: 650;
}

.lede {
  max-width: 590px;
  margin-bottom: 30px;
  color: var(--muted);
  font-size: 17px;
  line-height: 1.6;
}

.add-form {
  display: flex;
  gap: 10px;
  padding: 8px;
  max-width: 650px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
}

.add-form input {
  flex: 1;
  min-width: 0;
  padding: 11px 13px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font-size: 15px;
}

.add-form input::placeholder { color: var(--faint); }

.add-form button,
.login-form button {
  border: 0;
  border-radius: 11px;
  padding: 11px 18px;
  background: var(--ink);
  color: var(--bg);
  font-weight: 650;
  white-space: nowrap;
  transition: transform 120ms ease, opacity 120ms ease;
}

.add-form button:hover,
.login-form button:hover { transform: translateY(-1px); opacity: 0.92; }

.fine-print {
  margin: 12px 2px 0;
  color: var(--faint);
  font-size: 12px;
}

.fine-print strong { color: var(--muted); }

.banner {
  margin: 0 0 18px;
  padding: 12px 15px;
  border-radius: 12px;
  font-size: 14px;
}

.banner.success {
  background: var(--green-soft);
  color: var(--green);
}

.banner.error {
  background: var(--red-soft);
  color: var(--red);
}

.library { padding: 12px 0 70px; }

.library-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
}

.library-head h2 {
  margin: 0;
  font-size: 24px;
  letter-spacing: -0.03em;
}

.search-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-form input {
  width: 190px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--ink);
  outline: 0;
  font-size: 13px;
}

.search-form input:focus { border-color: var(--line-strong); }

.search-form button,
.small-button {
  display: inline-block;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: transparent;
  color: var(--ink);
  text-decoration: none;
  font-size: 12px;
  font-weight: 650;
}

.clear-search {
  color: var(--muted);
  font-size: 12px;
  text-decoration: none;
}

.cards {
  display: grid;
  gap: 18px;
}

.card {
  padding: 22px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.4) inset;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
}

.author {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.avatar {
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--surface-soft);
}

.avatar-fallback {
  display: grid;
  place-items: center;
  color: var(--muted);
  font-weight: 700;
}

.author-text { min-width: 0; }

.author-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  font-size: 14px;
}

.author-line strong {
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.verified {
  display: inline-grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--accent);
  color: white;
  font-size: 9px;
}

.handle, .meta {
  color: var(--muted);
  font-size: 12px;
}

.x-link {
  color: var(--muted);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}

.tweet-text {
  margin-bottom: 16px;
  font-size: 17px;
  line-height: 1.62;
  letter-spacing: -0.012em;
  overflow-wrap: anywhere;
}

.tweet-text a { color: var(--accent-ink); text-underline-offset: 2px; }

.media-grid {
  display: grid;
  gap: 6px;
  margin: 0 0 16px;
  min-width: 0;
  overflow: hidden;
  border-radius: 14px;
}

.media-grid.media-count-1 { grid-template-columns: 1fr; }
.media-grid.media-count-2 { grid-template-columns: repeat(2, 1fr); }
.media-grid.media-count-3 { grid-template-columns: repeat(3, 1fr); }
.media-grid.media-count-4 { grid-template-columns: repeat(2, 1fr); }

.media-cell {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--surface-soft);
}

.media-cell img,
.media-cell video {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  max-height: 520px;
  object-fit: cover;
}

.media-count-1 img,
.media-count-1 video { max-height: 640px; object-fit: contain; }

.media-cell a { display: block; }

.linked-article {
  margin: 0 0 16px;
  padding: 17px 18px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: linear-gradient(135deg, var(--accent-soft), var(--surface-soft));
}

.linked-article-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}

.linked-article h3 {
  margin: 0 0 7px;
  font-size: 20px;
  letter-spacing: -0.025em;
}

.linked-article p {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
}

.article-open {
  color: var(--muted);
  font-size: 12px;
  text-decoration: none;
}

.article-note {
  color: var(--faint);
  font-size: 11px;
}

.link-stack {
  display: grid;
  gap: 8px;
  margin: 0 0 16px;
}

.link-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface-soft);
  text-decoration: none;
  transition: border-color 140ms ease, transform 140ms ease;
}

.link-card:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.link-kind {
  flex: 0 0 auto;
  min-width: 43px;
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--ink);
  color: var(--bg);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-align: center;
  text-transform: uppercase;
}

.link-card-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.link-card-body strong {
  font-size: 13px;
  line-height: 1.35;
}

.link-description {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.link-host {
  color: var(--faint);
  font-size: 10px;
}

.link-arrow {
  margin-left: auto;
  color: var(--faint);
  font-size: 12px;
}

.quote {
  margin: 0 0 16px;
  padding: 15px 16px;
  border-left: 3px solid var(--accent);
  border-radius: 0 14px 14px 0;
  background: var(--surface-soft);
}

.quote-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.quote-label {
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.quote-author {
  color: var(--muted);
  font-size: 12px;
}

.quote-author span { color: var(--faint); }

.quote-text {
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.quote .media-grid { margin: 12px 0 0; }

.summary {
  margin: 18px 0 16px;
  padding: 17px 18px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: color-mix(in srgb, var(--accent-soft) 45%, var(--surface));
}

.summary.pending { border-style: dashed; }
.summary.failed { border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
.summary.disabled { background: var(--surface-soft); }

.summary-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
}

.summary-head h3 {
  margin: 0;
  font-size: 14px;
  letter-spacing: -0.01em;
}

.summary-mark {
  display: inline-grid;
  place-items: center;
  width: 25px;
  height: 25px;
  border-radius: 8px;
  background: var(--accent);
  color: white;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.03em;
}

.summary-time {
  margin-left: auto;
  color: var(--faint);
  font-size: 11px;
}

.summary-text {
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.summary-text a { color: var(--accent-ink); }

.summary-note {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.summary-retry { margin-top: 10px; }

.pulse-line {
  display: flex;
  gap: 5px;
  margin: 10px 0 8px;
}

.pulse-line span {
  width: 28px;
  height: 5px;
  border-radius: 999px;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

.pulse-line span:nth-child(2) { animation-delay: 0.15s; width: 42px; }
.pulse-line span:nth-child(3) { animation-delay: 0.3s; width: 18px; }

@keyframes pulse {
  0%, 100% { opacity: 0.25; transform: scaleX(0.9); }
  50% { opacity: 1; transform: scaleX(1); }
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 13px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}

.metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.metrics strong { color: var(--ink); font-weight: 650; }

.card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.card-actions a { text-decoration: none; }
.card-actions a:hover { color: var(--ink); }

.inline-form { display: inline; }

.link-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link-button:hover { color: var(--ink); }
.link-button.danger:hover { color: var(--red); }

.dot { color: var(--faint); }

.empty {
  padding: 46px 24px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  text-align: center;
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}

.empty-mark {
  margin-bottom: 8px;
  color: var(--accent);
  font-size: 30px;
}

.empty h3 { margin-bottom: 6px; }
.empty p { color: var(--muted); }

.paging-note {
  margin: 18px 0 0;
  color: var(--faint);
  font-size: 12px;
  text-align: center;
}

.footer {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding: 26px 0 44px;
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 11px;
}

.footer a { color: var(--muted); }

.login-page {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
}

.login-wrap { width: min(430px, 100%); }

.login-card {
  padding: 34px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 26px;
  box-shadow: var(--shadow);
}

.login-card h1 {
  margin: 18px 0 10px;
  font-size: 34px;
  letter-spacing: -0.045em;
}

.login-card .lede { margin-bottom: 22px; font-size: 14px; }

.login-form { display: grid; gap: 8px; }

.login-form label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.login-form input {
  padding: 11px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--bg);
  color: var(--ink);
  outline: 0;
}

.login-form input:focus { border-color: var(--accent); }

.login-form button { margin-top: 8px; }

.setup-card code, .setup-card pre {
  display: block;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--surface-soft);
  color: var(--accent-ink);
  font-size: 12px;
  overflow-x: auto;
}

.topic-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 18px 0 0;
}

.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 13px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  line-height: 1.2;
}

.topic-chip:hover { border-color: var(--ink); }

.topic-chip span {
  color: var(--faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.topic-chip.active {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--bg);
}

.topic-chip.active span { color: var(--bg); opacity: 0.6; }

.topic-hero {
  padding: 46px 0 30px;
  max-width: 760px;
}

.topic-hero h1 {
  margin: 6px 0 10px;
  font-family: var(--serif);
  font-size: clamp(34px, 6vw, 54px);
  font-weight: 500;
  letter-spacing: -0.025em;
  line-height: 1.02;
}

.topic-description {
  margin: 0 0 22px;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.55;
  max-width: 620px;
}

.topic-overview {
  padding: 20px 22px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--surface-soft);
}

.topic-overview p {
  margin: 0 0 14px;
  font-size: 15.5px;
  line-height: 1.68;
  color: var(--ink);
}

.topic-overview p:last-child { margin-bottom: 0; }

.topic-overview-empty {
  color: var(--faint);
  font-size: 14px;
  font-style: italic;
}

.card-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 10px 0 2px;
}

.card-topic {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-decoration: none;
}

.card-topic:hover { background: var(--accent); color: #fff; }

@media (max-width: 650px) {
  .shell, .topbar { width: min(100% - 24px, 820px); }
  .topbar { padding-top: 18px; }
  .topic-bar { padding-top: 12px; gap: 6px; }
  .topic-chip { padding: 6px 11px; font-size: 12px; }
  .hero { padding: 54px 0 38px; }
  .hero h1 { font-size: clamp(38px, 12vw, 58px); }
  .lede { font-size: 15px; }
  .add-form { flex-direction: column; padding: 6px; }
  .add-form button { width: 100%; }
  .library-head { align-items: flex-start; flex-direction: column; }
  .search-form { width: 100%; }
  .search-form input { flex: 1; width: auto; }
  .card { padding: 16px; border-radius: 18px; }
  .tweet-text { font-size: 16px; }
  .card-foot { align-items: flex-start; flex-direction: column; }
  .media-grid.media-count-3 { grid-template-columns: repeat(2, 1fr); }
  .media-grid.media-count-3 .media-cell:first-child { grid-column: span 2; }
  .top-actions .count { display: none; }
  .login-card { padding: 25px; }
  .topic-hero { padding: 30px 0 20px; }
  .topic-overview { padding: 16px 17px; }
  .topic-overview p { font-size: 15px; }
}
`;
