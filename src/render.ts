import type {
  Author,
  Bookmark,
  CalendarResult,
  LinkRead,
  MediaItem,
  Metrics,
  Quote,
  SummaryVersion,
  TopicSummary,
  XArticle,
} from './types.ts';
import {
  escapeHtml,
  formatCount,
  formatDate,
  linkifyText,
  safeHttpUrl,
  truncate,
} from './util.ts';

const NOTICES: Record<string, string> = {
  shared: 'Saved from the Android share sheet.',
  added: 'Saved. The summary is running in the background.',
  exists: 'Already saved. The post has been refreshed.',
  deleted: 'Bookmark removed.',
  queued: 'Summary queued again.',
  version: 'New version queued. The original summary stays as it is.',
  archived: 'Bookmark archived. It leaves the active list but stays in the archive.',
  unarchived: 'Bookmark moved back to the active list.',
  translating: 'English summaries queued. Each one appears when the background job finishes it.',
  translated: 'English summary queued.',
  'translated-none': 'Every finished summary already has an English version.',
};

export interface RenderPageOptions {
  bookmarks: Bookmark[];
  total: number;
  query: string;
  day?: string | null;
  topics?: TopicSummary[];
  topic?: TopicSummary | null;
  notice?: string | null;
  error?: string | null;
  aiConfigured?: boolean;
  view?: 'active' | 'archived';
  lang?: 'tr' | 'en';
  activeTotal?: number;
  archivedTotal?: number;
  missingEnglish?: number;
  bilingual?: boolean;
}

/** Build a library/topic URL without empty or default parameters. */
function libraryHref(
  path: string,
  { query = '', day = null, view = 'active', lang = 'tr' }: {
    query?: string;
    day?: string | null;
    view?: 'active' | 'archived';
    lang?: 'tr' | 'en';
  } = {},
): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (day) params.set('day', day);
  if (view === 'archived') params.set('view', 'archived');
  if (lang === 'en') params.set('lang', 'en');
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function renderPage({
  bookmarks,
  total,
  query,
  day: dayOption = null,
  topics = [],
  topic = null,
  notice,
  error,
  aiConfigured = false,
  view: viewOption = 'active',
  lang: langOption = 'tr',
  activeTotal = 0,
  archivedTotal = 0,
  missingEnglish = 0,
  bilingual = false,
}: RenderPageOptions): string {
  const view = viewOption === 'archived' ? 'archived' : 'active';
  const lang = langOption === 'en' ? 'en' : 'tr';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dayOption || '')) ? String(dayOption) : null;
  const pending = bookmarks.some(
    bookmark =>
      ['pending', 'working'].includes(bookmark.summaryStatus) ||
      ['pending', 'working'].includes(bookmark.versionStatus || '') ||
      (lang === 'en' && ['pending', 'working'].includes(bookmark.summaryEnStatus || '')),
  );
  const path = topic ? `/t/${topic.slug}` : '/';
  const currentQuery = topic ? '' : query;
  const currentDay = topic ? null : day;
  const activeCount = topic ? topic.count : activeTotal;
  const archivedCount = topic ? topic.archivedCount : archivedTotal;
  const returnTo = libraryHref(path, { query: currentQuery, day: currentDay, view, lang });
  const noticeText = notice ? NOTICES[notice] : '';
  const addValue = escapeHtml(query || '');
  const showTranslateBanner =
    lang === 'en' && bilingual && aiConfigured && missingEnglish > 0;
  const dayLabel = currentDay ? formatDate(`${currentDay}T00:00:00.000Z`) : '';
  const calendarHref = lang === 'en' ? '/calendar?lang=en' : '/calendar';

  const topicTabs = topics
    .map(entry => {
      const tabCount = view === 'archived' ? entry.archivedCount : entry.count;
      return `
        <a class="topic-tab ${topic?.slug === entry.slug ? 'active' : ''}" href="${escapeHtml(
          libraryHref(`/t/${entry.slug}`, { view, lang }),
        )}"${entry.archivedCount ? ` title="${entry.archivedCount} archived"` : ''}>
          ${escapeHtml(entry.name)}<span>${tabCount ?? 0}</span>
        </a>
      `;
    })
    .join('');

  const eyebrow = topic
    ? `Topic · ${activeCount} active${archivedCount ? ` · ${archivedCount} archived` : ''}`
    : currentDay
      ? `Day · ${activeCount} active${archivedCount ? ` · ${archivedCount} archived` : ''}`
      : view === 'archived'
        ? `Archive · ${archivedCount} saved`
        : `Library · ${activeCount} active${archivedCount ? ` · ${archivedCount} archived` : ''}`;

  const heading = query
    ? currentDay
      ? `Results for “${escapeHtml(query)}” on ${escapeHtml(dayLabel)}`
      : `Results for “${escapeHtml(query)}”`
    : currentDay
      ? `Saved on ${escapeHtml(dayLabel)}`
      : topic
        ? escapeHtml(topic.name)
        : view === 'archived'
          ? 'Archived bookmarks'
          : 'Latest saves';

  return pageShell({
    title: topic
      ? `${topic.name} · X Bookmark Vault`
      : currentDay
        ? `${dayLabel} · X Bookmark Vault`
        : view === 'archived'
          ? 'Archive · X Bookmark Vault'
          : 'X Bookmark Vault',
    bodyClass: 'home',
    head: pending ? '<meta http-equiv="refresh" content="4">' : '',
    body: `
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark">X</span>
          <span>Bookmark Vault</span>
        </a>
        <div class="top-actions">
          <span class="count">${total} ${view === 'archived' ? 'archived' : 'active'}</span>
          <form method="post" action="/logout">
            <button class="link-button" type="submit">Log out</button>
          </form>
        </div>
      </header>

      <main class="shell">
        <details class="add-drawer">
          <summary><span class="add-icon">+</span> Save a link from X</summary>
          <form class="add-form" method="post" action="/add">
            <label class="sr-only" for="url">X post URL</label>
            <input id="url" name="url" type="url" inputmode="url" autocomplete="off" placeholder="https://x.com/user/status/…" required value="${addValue}">
            <button type="submit">Save post</button>
          </form>
          <p class="fine-print">On Android: <strong>Share → Bookmark Vault</strong> in X. The post, quote, article, links, and images are read and summarized automatically.</p>
        </details>

        ${noticeText ? `<div class="banner success">${escapeHtml(noticeText)}</div>` : ''}
        ${error ? `<div class="banner error">${escapeHtml(truncate(error, 400))}</div>` : ''}

        <section class="library" id="library">
          <div class="library-head">
            <div>
              <p class="eyebrow">${escapeHtml(eyebrow)}</p>
              <h2>${heading}</h2>
            </div>
            <div class="library-tools">
              <form class="search-form" method="get" action="/">
                ${currentDay ? `<input type="hidden" name="day" value="${escapeHtml(currentDay)}">` : ''}
                ${view === 'archived' ? '<input type="hidden" name="view" value="archived">' : ''}
                ${lang === 'en' ? '<input type="hidden" name="lang" value="en">' : ''}
                <label class="sr-only" for="q">Search bookmarks</label>
                <input id="q" name="q" type="search" placeholder="Search text or author" value="${escapeHtml(query || '')}">
                <button type="submit">Search</button>
                ${query ? `<a class="clear-search" href="${escapeHtml(libraryHref(path, { day: currentDay, view, lang }))}">Clear</a>` : ''}
              </form>
              <div class="library-switches">
                <nav class="view-switch" role="group" aria-label="Archive filter">
                  <a class="${view === 'active' ? 'active' : ''}" href="${escapeHtml(
                    libraryHref(path, { query: currentQuery, day: currentDay, view: 'active', lang }),
                  )}">Active<span>${activeCount}</span></a>
                  <a class="${view === 'archived' ? 'active' : ''}" href="${escapeHtml(
                    libraryHref(path, { query: currentQuery, day: currentDay, view: 'archived', lang }),
                  )}">Archived<span>${archivedCount}</span></a>
                </nav>
                ${
                  bilingual
                    ? `<nav class="lang-switch" role="group" aria-label="Summary language">
                        <a class="${lang === 'tr' ? 'active' : ''}" href="${escapeHtml(
                          libraryHref(path, { query: currentQuery, day: currentDay, view, lang: 'tr' }),
                        )}">Türkçe</a>
                        <a class="${lang === 'en' ? 'active' : ''}" href="${escapeHtml(
                          libraryHref(path, { query: currentQuery, day: currentDay, view, lang: 'en' }),
                        )}">English</a>
                      </nav>`
                    : ''
                }
                <a class="calendar-link" href="${escapeHtml(calendarHref)}" aria-label="Open the save calendar">Calendar</a>
              </div>
            </div>
          </div>

          ${
            currentDay
              ? `<div class="day-banner">
                  <span>Showing ${total} ${view === 'archived' ? 'archived' : 'active'} of ${activeCount + archivedCount} ${activeCount + archivedCount === 1 ? 'save' : 'saves'} from <strong>${escapeHtml(dayLabel)}</strong>.</span>
                  <a href="${escapeHtml(libraryHref(path, { query: currentQuery, view, lang }))}">Clear date</a>
                </div>`
              : ''
          }

          ${
            topic
              ? `<div class="topic-brief">
                  ${topic.description ? `<p class="topic-description">${escapeHtml(topic.description)}</p>` : ''}
                  ${
                    topic.overview
                      ? renderTopicOverview(topic.overview)
                      : `<p class="topic-overview-empty">The synthesis for this thread is still being written.</p>`
                  }
                  ${
                    lang === 'en' && topic.overview
                      ? '<p class="topic-language-note">Topic syntheses are written in Turkish.</p>'
                      : ''
                  }
                </div>`
              : ''
          }

          ${
            showTranslateBanner
              ? `<div class="translate-banner">
                  <div>
                    <strong>English board</strong>
                    <p>${missingEnglish} finished ${missingEnglish === 1 ? 'summary has' : 'summaries have'} no English version yet. They are written in the background, one at a time.</p>
                  </div>
                  <form method="post" action="/translate-missing">
                    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
                    <button class="small-button" type="submit">Write them</button>
                  </form>
                </div>`
              : ''
          }

          <nav class="topic-tabs" aria-label="Topics">
            <a class="topic-tab all ${topic ? '' : 'active'}" href="${escapeHtml(
              libraryHref('/', { day: currentDay, view, lang }),
            )}">All${topic ? '' : `<span>${view === 'archived' ? archivedCount : activeCount}</span>`}</a>
            ${topicTabs}
          </nav>

          ${
            bookmarks.length
              ? `<div class="cards">${bookmarks
                  .map(bookmark => renderBookmark(bookmark, aiConfigured, returnTo, lang, bilingual))
                  .join('')}</div>`
              : renderEmpty(query, view, currentDay)
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

export interface RenderCalendarOptions {
  calendar: CalendarResult;
  lang?: 'tr' | 'en';
  error?: string | null;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, number - 1, 1)));
}

function monthShort(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, number - 1, 1)));
}

function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}

function calendarHref(month: string, lang: 'tr' | 'en'): string {
  const params = new URLSearchParams();
  if (month !== new Date().toISOString().slice(0, 7)) params.set('month', month);
  if (lang === 'en') params.set('lang', 'en');
  const search = params.toString();
  return search ? `/calendar?${search}` : '/calendar';
}

export function renderCalendar({
  calendar,
  lang: langOption = 'tr',
  error,
}: RenderCalendarOptions): string {
  const lang = langOption === 'en' ? 'en' : 'tr';
  const month = calendar.month;
  const label = monthLabel(month);
  const [year, number] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, number - 1, 1)).getUTCDay();
  const leading = (firstDay + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);
  const counts = new Map((calendar.days || []).map(day => [day.date, day.count]));

  const blanks = Array.from(
    { length: leading },
    () => '<span class="cal-day is-blank" aria-hidden="true"></span>',
  ).join('');

  const cells = Array.from({ length: daysInMonth }, (_, index) => {
    const dayNumber = index + 1;
    const date = `${month}-${String(dayNumber).padStart(2, '0')}`;
    const count = counts.get(date) || 0;
    const isToday = date === today;
    const classes = ['cal-day', count ? 'has-items' : '', isToday ? 'is-today' : '']
      .filter(Boolean)
      .join(' ');

    if (!count) {
      return `<span class="${classes}"><span class="cal-num">${dayNumber}</span></span>`;
    }

    const dayLabel = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00.000Z`));

    return `<a class="${classes}" href="${escapeHtml(
      libraryHref('/', { day: date, lang }),
    )}" aria-label="${escapeHtml(dayLabel)}, ${count} ${count === 1 ? 'save' : 'saves'}">
      <span class="cal-num">${dayNumber}</span>
      <span class="cal-count">${count}</span>
    </a>`;
  }).join('');

  return pageShell({
    title: `${label} · Calendar · X Bookmark Vault`,
    bodyClass: 'home calendar-page',
    head: '',
    body: `
      <header class="topbar">
        <a class="brand" href="${escapeHtml(libraryHref('/', { lang }))}">
          <span class="brand-mark">X</span>
          <span>Bookmark Vault</span>
        </a>
        <div class="top-actions">
          <span class="count">${calendar.total} saved this month</span>
          <form method="post" action="/logout">
            <button class="link-button" type="submit">Log out</button>
          </form>
        </div>
      </header>

      <main class="shell">
        <section class="library calendar">
          <div class="calendar-head">
            <div>
              <p class="eyebrow">Calendar · ${calendar.total} ${calendar.total === 1 ? 'save' : 'saves'}</p>
              <h2>${escapeHtml(label)}</h2>
            </div>
            <nav class="calendar-nav" aria-label="Calendar months">
              <a href="${escapeHtml(calendarHref(shiftMonth(month, -1), lang))}" aria-label="Previous month">‹ ${escapeHtml(monthShort(shiftMonth(month, -1)))}</a>
              <a href="${escapeHtml(calendarHref(new Date().toISOString().slice(0, 7), lang))}">This month</a>
              <a href="${escapeHtml(calendarHref(shiftMonth(month, 1), lang))}" aria-label="Next month">${escapeHtml(monthShort(shiftMonth(month, 1)))} ›</a>
            </nav>
          </div>

          ${error ? `<div class="banner error">${escapeHtml(truncate(error, 400))}</div>` : ''}

          <p class="calendar-note">Days use UTC and match the dates on the cards. Counts include archived bookmarks.</p>

          <div class="calendar-grid" role="grid" aria-label="Saves per day, ${escapeHtml(label)}">
            ${WEEKDAYS.map(day => `<span class="cal-weekday" role="columnheader">${day}</span>`).join('')}
            ${blanks}
            ${cells}
          </div>

          <p class="calendar-hint">Pick a day to see only what you saved then.</p>
          <a class="small-button" href="${escapeHtml(libraryHref('/', { lang }))}">Back to the library</a>
        </section>
      </main>

      <footer class="footer shell">
        <span>Read via FxTwitter</span>
        <span class="dot">·</span>
        <span>Summaries by OpenCode</span>
      </footer>
    `,
  });
}

function renderParagraphs(text: unknown): string {
  return String(text || '')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
}

function renderTopicOverview(text: unknown): string {
  const foldable = String(text || '').length > 700;
  return `
    <div class="topic-overview ${foldable ? 'is-folded' : ''}">
      <div class="topic-overview-body">${renderParagraphs(text)}</div>
      ${foldable ? '<button class="fold-button" type="button" data-fold>Read the full synthesis</button>' : ''}
    </div>
  `;
}

function renderBookmark(
  bookmark: Bookmark,
  aiConfigured: boolean,
  returnTo = '/',
  lang: 'tr' | 'en' = 'tr',
  bilingual = false,
): string {
  const author: Partial<Author> = bookmark.author ?? {};
  const handle = author.username ? `@${author.username}` : 'unknown';
  const avatar = safeHttpUrl(author.avatarUrl);
  const initial = escapeHtml((author.name || author.username || '?').slice(0, 1).toUpperCase());
  const archived = Boolean(bookmark.archivedAt);

  const extras = [];
  if (bookmark.article) extras.push('X Article');
  const mediaCount = (bookmark.media ?? []).filter(item => safeHttpUrl(item.url)).length;
  if (mediaCount) extras.push(`${mediaCount} ${mediaCount === 1 ? 'image' : 'images'}`);
  if (bookmark.quote) extras.push('quoted post');
  const linkCount = (bookmark.links ?? []).length;
  if (linkCount) extras.push(`${linkCount} ${linkCount === 1 ? 'link' : 'links'}`);

  return `
    <article class="card is-collapsed${archived ? ' is-archived' : ''}" id="bookmark-${escapeHtml(bookmark.tweetId)}">
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
            <div class="meta">
              ${escapeHtml(formatDate(bookmark.createdAt))}
              ${
                bookmark.ref
                  ? `<button class="ref-chip" type="button" data-copy="${escapeHtml(bookmark.ref)}" title="Copy bookmark id" aria-label="Bookmark id ${escapeHtml(bookmark.ref)}, click to copy">#${escapeHtml(bookmark.ref)}</button>`
                  : ''
              }
              ${archived ? '<span class="archive-chip">Archived</span>' : ''}
            </div>
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
      ${renderSummary(bookmark, aiConfigured, returnTo, lang, bilingual)}

      ${extras.length ? `<p class="peek-meta">${escapeHtml(extras.join(' · '))}</p>` : ''}

      <footer class="card-foot">
        <div class="metrics">${renderMetrics(bookmark.metrics)}</div>
        <div class="card-actions">
          <button class="expand-button" type="button" data-expand aria-expanded="false">Read more</button>
          <span class="dot">·</span>
          <a href="/api/bookmarks/${escapeHtml(bookmark.tweetId)}" target="_blank" rel="noopener">JSON</a>
          <span class="dot">·</span>
          <a href="${escapeHtml(safeHttpUrl(bookmark.url) || '#')}" target="_blank" rel="noopener noreferrer">Open on X</a>
          <span class="dot">·</span>
          <form method="post" action="/archive" class="inline-form">
            <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
            <input type="hidden" name="archived" value="${archived ? '0' : '1'}">
            <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
            <button class="link-button" type="submit">${archived ? 'Unarchive' : 'Archive'}</button>
          </form>
          <span class="dot">·</span>
          <form method="post" action="/delete" class="inline-form">
            <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
            <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
            <button class="link-button danger" type="submit">Remove</button>
          </form>
        </div>
      </footer>
    </article>
  `;
}

function renderQuote(quote: Quote): string {
  const author: Partial<Author> = quote.author ?? {};
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

function renderArticle(article: XArticle): string {
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

function renderLinks(links: LinkRead[]): string {
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

function renderMedia(media: MediaItem[] | null | undefined, context: string): string {
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

function renderVersion(entry: SummaryVersion): string {
  const label = entry.instruction ? truncate(entry.instruction, 90) : 'Another angle';
  return `
    <details class="version">
      <summary>
        <span class="version-tag">v${Number(entry.version)}</span>
        <span class="version-label">${escapeHtml(label)}</span>
      </summary>
      <div class="version-text">${linkifyText(entry.summary)}</div>
    </details>
  `;
}

function renderSummary(
  bookmark: Bookmark,
  aiConfigured: boolean,
  returnTo = '/',
  lang: 'tr' | 'en' = 'tr',
  bilingual = false,
): string {
  const status = bookmark.summaryStatus || (aiConfigured ? 'pending' : 'disabled');

  if (status === 'done' && bookmark.summary) {
    const versions = Array.isArray(bookmark.versions) ? bookmark.versions : [];
    const busy = ['pending', 'working'].includes(bookmark.versionStatus ?? '');
    const preferEnglish = bilingual && lang === 'en';
    const englishReady = Boolean(bookmark.summaryEn) && bookmark.summaryEnStatus === 'done';
    const englishBusy = ['pending', 'working'].includes(bookmark.summaryEnStatus ?? '');
    const englishFailed = bookmark.summaryEnStatus === 'failed';
    const useEnglish = preferEnglish && englishReady;
    const shownSummary = useEnglish ? String(bookmark.summaryEn) : bookmark.summary;
    const languageTag = useEnglish ? 'EN' : bilingual ? 'TR' : '';

    const translateForm =
      preferEnglish && !englishReady && aiConfigured
        ? `<form method="post" action="/summarize" class="summary-translate">
            <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
            <input type="hidden" name="mode" value="translate">
            <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
            <button class="small-button" type="submit">Write English summary</button>
          </form>`
        : '';

    const englishNote = preferEnglish
      ? englishBusy
        ? '<p class="summary-note">The English version is being written. The Turkish original is shown below.</p>'
        : englishFailed
          ? `<p class="summary-note error">English translation failed: ${escapeHtml(
              truncate(bookmark.summaryEnError || 'unknown error', 200),
            )}</p>${translateForm}`
          : useEnglish
            ? '<p class="summary-note">Translated from the Turkish summary.</p>'
            : `<p class="summary-note">No English version yet. The Turkish original is shown below.</p>${translateForm}`
      : '';

    return `
      <section class="summary">
        <div class="summary-head">
          <span class="summary-mark">AI</span>
          <h3>Summary</h3>
          ${languageTag ? `<span class="lang-tag">${languageTag}</span>` : ''}
          ${versions.length ? `<span class="summary-count">${versions.length + 1} versions</span>` : ''}
          <span class="summary-time">${escapeHtml(
            formatDate(useEnglish ? bookmark.summaryEnAt : bookmark.summarizedAt),
          )}</span>
        </div>
        <div class="summary-text"${useEnglish ? ' lang="en"' : ''}>${linkifyText(shownSummary)}</div>
        ${englishNote}

        ${versions.length ? `<div class="versions">${versions.map(renderVersion).join('')}</div>` : ''}
        ${
          versions.length && preferEnglish
            ? '<p class="version-language-note">Alternative versions are in Turkish.</p>'
            : ''
        }
        ${busy ? `<p class="version-note">Writing version ${versions.length + 2}…</p>` : ''}
        ${
          bookmark.versionError
            ? `<p class="version-note error">${escapeHtml(truncate(bookmark.versionError, 240))}</p>`
            : ''
        }

        <details class="regen">
          <summary>New version</summary>
          <form method="post" action="/summarize">
            <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
            <input type="hidden" name="mode" value="version">
            <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
            <label class="sr-only" for="instruction-${escapeHtml(bookmark.tweetId)}">What should this version focus on?</label>
            <input class="regen-input" id="instruction-${escapeHtml(bookmark.tweetId)}" name="instruction" maxlength="500" placeholder="Optional: explain the tradeoffs, the history, what to do…">
            <button type="submit">Write</button>
          </form>
          <p class="regen-note">The original summary stays as it is. Each request becomes a new version, written in Turkish.</p>
        </details>
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

function renderMetrics(metrics: Partial<Metrics> = {}) {
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

function renderEmpty(
  query: string,
  view: 'active' | 'archived' = 'active',
  day: string | null = null,
): string {
  if (query) {
    return `
      <div class="empty">
        <p class="empty-mark">∅</p>
        <h3>${view === 'archived' ? 'No matches in the archive' : 'No matches'}</h3>
        <p>Nothing ${view === 'archived' ? 'archived ' : ''}in the library matches “${escapeHtml(query)}”${day ? ' on this day' : ''}.</p>
        <a class="small-button" href="${escapeHtml(libraryHref('/', { day, view }))}">Clear search</a>
      </div>
    `;
  }

  if (day) {
    const label = formatDate(`${day}T00:00:00.000Z`);
    return `
      <div class="empty">
        <p class="empty-mark">·</p>
        <h3>Nothing saved on ${escapeHtml(label)}</h3>
        <p>Pick another day from the calendar, or go back to the whole library.</p>
        <a class="small-button" href="/calendar">Open calendar</a>
        <a class="small-button" href="/">Back to library</a>
      </div>
    `;
  }

  if (view === 'archived') {
    return `
      <div class="empty">
        <p class="empty-mark">▣</p>
        <h3>Nothing archived yet</h3>
        <p>Archive a bookmark when you are done with it. It leaves the active list but stays searchable and keeps its summary.</p>
        <a class="small-button" href="/">Back to active bookmarks</a>
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

export function renderLogin({ error, next }: { error?: string | null; next?: string | null } = {}): string {
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

export function renderSetup(): string {
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

function pageShell({ title, bodyClass, head, body }: { title: string; bodyClass: string; head: string; body: string }): string {
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
  <link rel="stylesheet" href="/style.css?v=8">
  ${head}
  <noscript><style>
    .card.is-collapsed .tweet-text,
    .card.is-collapsed .summary-text { display: block; overflow: visible; -webkit-line-clamp: unset; }
    .card.is-collapsed .media-grid,
    .card.is-collapsed .quote,
    .card.is-collapsed .link-stack,
    .card.is-collapsed .linked-article { display: block; }
    .peek-meta, .expand-button { display: none; }
  </style></noscript>
  <script src="/app.js" defer></script>
</head>
<body class="${escapeHtml(bodyClass)}">
  ${body}
</body>
</html>`;
}

export const CSS: string = `:root {
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

.library.is-loading {
  opacity: 0.55;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

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

.library-tools {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.library-switches {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.view-switch,
.lang-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
}

.view-switch a,
.lang-switch a {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.view-switch a:hover,
.lang-switch a:hover { color: var(--ink); }

.view-switch a.active,
.lang-switch a.active {
  background: var(--ink);
  color: var(--bg);
}

.view-switch span {
  color: inherit;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  opacity: 0.65;
}

.calendar-link {
  display: inline-flex;
  align-items: center;
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.calendar-link:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.day-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 14px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 12.5px;
}

.day-banner strong { color: var(--ink); }

.day-banner a {
  color: var(--accent-ink);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.calendar-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 8px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
}

.calendar-head h2 {
  margin: 0;
  font-size: clamp(28px, 5vw, 38px);
  letter-spacing: -0.04em;
}

.calendar-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.calendar-nav a {
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.calendar-nav a:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.calendar-note {
  margin: 0 0 16px;
  color: var(--faint);
  font-size: 12px;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.cal-weekday {
  padding: 4px 0;
  color: var(--faint);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-align: center;
  text-transform: uppercase;
}

.cal-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 64px;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--ink);
  text-decoration: none;
}

.cal-day.has-items {
  border-color: var(--line);
  background: var(--surface);
  transition: border-color 130ms ease, transform 130ms ease;
}

.cal-day.has-items:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.cal-num {
  font-size: 13.5px;
  font-variant-numeric: tabular-nums;
}

.cal-count {
  margin-top: 3px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.cal-day.is-today { border-color: var(--accent); }
.cal-day.is-today .cal-num { font-weight: 800; }

.calendar-hint {
  margin: 14px 0 10px;
  color: var(--faint);
  font-size: 12px;
}

.archive-chip {
  margin-left: 6px;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 600;
}

.card.is-archived {
  background: color-mix(in srgb, var(--surface) 82%, var(--bg));
}

.card.is-archived .tweet-text { color: var(--muted); }

.lang-tag {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--ink);
  color: var(--bg);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.05em;
}

.summary-translate { margin-top: 8px; }

.summary-note.error { color: var(--red); }

.translate-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 0 0 14px;
  padding: 12px 14px;
  border: 1px dashed var(--line-strong);
  border-radius: 13px;
  background: var(--surface-soft);
}

.translate-banner strong { font-size: 13px; }

.translate-banner p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.translate-banner form { flex: 0 0 auto; }

.topic-language-note,
.version-language-note {
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 11.5px;
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
  min-width: 0;
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

.ref-chip {
  margin-left: 6px;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}

.ref-chip:hover {
  color: var(--ink);
  border-color: var(--accent);
}

.ref-chip.is-copied {
  color: var(--accent-ink);
  border-color: var(--accent);
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

.summary-count {
  color: var(--faint);
  font-size: 11px;
  font-weight: 500;
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

.add-drawer {
  margin: 16px 0 10px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  overflow: hidden;
}

.add-drawer summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  list-style: none;
}

.add-drawer summary::-webkit-details-marker { display: none; }

.add-drawer[open] summary { border-bottom: 1px solid var(--line); }

.add-icon {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ink);
  color: var(--bg);
  font-size: 15px;
  font-weight: 500;
  line-height: 1;
  transition: transform 0.18s ease;
}

.add-drawer[open] .add-icon { transform: rotate(45deg); }

.add-drawer .add-form {
  margin: 12px;
  max-width: none;
  border: none;
  background: var(--surface-soft);
  box-shadow: none;
}

.add-drawer .fine-print {
  margin: 0;
  padding: 0 16px 14px;
}

.topic-brief {
  max-width: 720px;
  margin: 4px 0 10px;
}

.topic-description {
  margin: 0 0 14px;
  max-width: 620px;
  color: var(--muted);
  font-size: 15.5px;
  line-height: 1.55;
}

.topic-overview {
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--surface-soft);
}

.topic-overview p {
  overflow-wrap: anywhere;
  margin: 0 0 14px;
  color: var(--ink);
  font-size: 15px;
  line-height: 1.68;
}

.topic-overview p:last-child { margin-bottom: 0; }

.topic-overview-empty {
  color: var(--faint);
  font-size: 14px;
  font-style: italic;
}

.topic-tabs {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  gap: 2px;
  margin: 14px 0 0;
  background: var(--bg);
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  scrollbar-width: none;
}

.topic-tabs::-webkit-scrollbar { display: none; }

.topic-tab {
  flex: 0 0 auto;
  padding: 12px 13px 11px;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.01em;
  text-decoration: none;
  white-space: nowrap;
}

.topic-tab:hover { color: var(--ink); }

.topic-tab.active {
  color: var(--ink);
  border-bottom-color: var(--accent);
  font-weight: 650;
}

.topic-tab span {
  margin-left: 6px;
  color: var(--faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.topic-tab.active span { color: var(--accent); }

.topic-overview.is-folded .topic-overview-body {
  position: relative;
  max-height: 7.8em;
  overflow: hidden;
}

.topic-overview.is-folded .topic-overview-body::after {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 3.2em;
  background: linear-gradient(transparent, var(--surface-soft));
}

.fold-button {
  margin-top: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent-ink);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.fold-button:hover { text-decoration: underline; }

.versions {
  min-width: 0;
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.version {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}

.version summary {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12.5px;
  list-style: none;
}

.version summary::-webkit-details-marker { display: none; }

.version-tag {
  color: var(--accent-ink);
  font-size: 11px;
  font-weight: 700;
}

.version-label {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-text {
  overflow-wrap: anywhere;
  padding: 0 12px 12px;
  font-size: 14px;
  line-height: 1.6;
}

.regen { margin-top: 12px; }

.regen summary {
  color: var(--accent-ink);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

.regen summary::-webkit-details-marker { display: none; }

.regen form {
  display: flex;
  gap: 8px;
  margin-top: 9px;
}

.regen-input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}

.regen button {
  padding: 8px 13px;
  border: none;
  border-radius: 10px;
  background: var(--ink);
  color: var(--bg);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.regen-note {
  margin: 6px 0 0;
  color: var(--faint);
  font-size: 11.5px;
}

.version-note {
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 12.5px;
}

.version-note.error { color: var(--red); }

.card.is-collapsed { cursor: pointer; }

.card.is-collapsed .tweet-text,
.card.is-collapsed .summary-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card.is-collapsed .media-grid,
.card.is-collapsed .quote,
.card.is-collapsed .link-stack,
.card.is-collapsed .linked-article,
.card.is-collapsed .versions,
.card.is-collapsed .regen { display: none; }

.peek-meta {
  display: none;
  margin: 10px 0 0;
  color: var(--faint);
  font-size: 12px;
}

.card.is-collapsed .peek-meta { display: block; }

.expand-button {
  padding: 5px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.expand-button:hover { border-color: var(--ink); }

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
  .topic-tabs { margin-top: 10px; }
  .topic-tab { padding: 10px 11px 9px; font-size: 12.5px; }
  .card.is-collapsed .tweet-text,
  .card.is-collapsed .summary-text { -webkit-line-clamp: 2; }
  .hero { padding: 54px 0 38px; }
  .hero h1 { font-size: clamp(38px, 12vw, 58px); }
  .lede { font-size: 15px; }
  .add-form { flex-direction: column; padding: 6px; }
  .add-form button { width: 100%; }
  .library-head { align-items: flex-start; flex-direction: column; }
  .library-tools { width: 100%; align-items: stretch; }
  .library-switches { justify-content: space-between; }
  .translate-banner { align-items: flex-start; flex-direction: column; }
  .search-form { width: 100%; }
  .search-form input { flex: 1; width: auto; }
  .card { padding: 16px; border-radius: 18px; }
  .tweet-text { font-size: 16px; }
  .card-foot { align-items: flex-start; flex-direction: column; }
  .media-grid.media-count-3 { grid-template-columns: repeat(2, 1fr); }
  .media-grid.media-count-3 .media-cell:first-child { grid-column: span 2; }
  .top-actions .count { display: none; }
  .login-card { padding: 25px; }
  .regen form { flex-direction: column; }
  .topic-brief { margin: 0 0 8px; }
  .topic-overview { padding: 15px 16px; }
  .topic-overview { padding: 16px 17px; }
  .topic-overview p { font-size: 15px; }
  .calendar-head { align-items: flex-start; flex-direction: column; gap: 10px; }
  .calendar-grid { gap: 4px; }
  .cal-day { min-height: 50px; border-radius: 9px; }
  .cal-weekday { font-size: 9px; }
  .cal-num { font-size: 12.5px; }
  .cal-count { padding: 0 5px; font-size: 9.5px; }
  .day-banner { align-items: flex-start; flex-direction: column; gap: 6px; }
}
`;
