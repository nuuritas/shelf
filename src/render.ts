import { DEFAULT_SUMMARY_PROMPT } from './ai.ts';
import {
  DEFAULT_APPEARANCE,
  appearanceAttributes,
  themeColorMeta,
  type Appearance,
} from './appearance.ts';
import { BRAND_CSS, BRAND_MARK, assetUrl } from './brand.ts';
import { CHANGELOG } from './changelog-data.ts';
import {
  formatChangelogDate,
  latestChangelogBullets,
  renderChangelogBullet,
  type ChangelogEntry,
} from './changelog.ts';
import { LABEL_TONE_COUNT, labelTone } from './labels.ts';
import { LANGUAGE_TAG_MAX, languageOf, languageOptions } from './languages.ts';
import { renderMarkdown } from './markdown.ts';
import { MAX_SUMMARY_PROMPT_LENGTH } from './settings.ts';
import { youtubeVideoId } from './transcript.ts';
import type {
  Author,
  Bookmark,
  CalendarResult,
  LabelSummary,
  LinkRead,
  MediaItem,
  Quote,
  SourceFilter,
  StoredSettings,
  SummaryLanguage,
  SummaryVersion,
  TopicSummary,
  UiLang,
  VideoTranscript,
  XArticle,
} from './types.ts';
import {
  escapeHtml,
  formatDate,
  linkifyText,
  parseSource,
  safeHttpUrl,
  sourceOfUrl,
  truncate,
} from './util.ts';

/**
 * Where the footer's Android link goes: GitHub's release page, not the asset.
 *
 * The asset URL 302s through `releases/latest/download/…` to a signed asset
 * URL. curl and desktop Chrome follow that chain; Android Chrome reaches the
 * full file size and never finishes, while tapping the same asset on the
 * release page downloads it first time. The page costs one tap and it is the
 * path a phone completes. Inside the Android app the WebView hands any host
 * that is not this site to the browser, so this link leaves the app cleanly
 * instead of trying to download in place.
 *
 * The direct asset URL stays in `INSTALL.md` for scripts. A fork that ships its
 * own APK should point this at its own release page.
 */
const ANDROID_APP_PAGE = 'https://github.com/nuuritas/shelfcloud-apk/releases/latest';

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
  labeled: 'Labels saved.',
};

/** The calendar's top-bar icon: a month grid in the bar's own stroke weight. */
const CALENDAR_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.2" y="4.6" width="17.6" height="16.8" rx="2.6"/><path d="M3.2 9.5h17.6M8 2.4v3.8M16 2.4v3.8"/><circle cx="8" cy="14.4" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="14.4" r="1.05" fill="currentColor" stroke="none"/><circle cx="16" cy="14.4" r="1.05" fill="currentColor" stroke="none"/></svg>`;

export interface RenderPageOptions {
  bookmarks: Bookmark[];
  total: number;
  query: string;
  day?: string | null;
  topics?: TopicSummary[];
  topic?: TopicSummary | null;
  /** The reader's labels, most carried first; the card chips link here too. */
  labels?: LabelSummary[];
  /**
   * The label slugs the library is cut to. `labels` above is the menu, so the
   * selection keeps its own name; `label` is the single-pick form it falls back
   * to, kept for callers that predate the arrays.
   */
  labelPicks?: string[];
  /** A label slug, when the library is filtered to one label. */
  label?: string | null;
  /**
   * The folder slugs the library is cut to. `topics` above is the menu; the
   * `topic` page keeps its own path instead of a parameter.
   */
  topicPicks?: string[];
  notice?: string | null;
  error?: string | null;
  aiConfigured?: boolean;
  view?: 'active' | 'archived';
  lang?: 'tr' | 'en';
  /** `saves` is the default home (flat latest-first); `folders` shows the topic grid. */
  layout?: 'folders' | 'saves';
  /** Platform filter; `all` (the default) shows every source. */
  source?: SourceFilter;
  /** The platforms the library is cut to; `source` is the single-pick form. */
  sources?: SourceFilter[];
  /**
   * The filter menu a pick came from (`source`, `folder` or `labels`), so the
   * panel it was used in reopens on the reload. Any other value opens none.
   */
  menu?: string | null;
  activeTotal?: number;
  archivedTotal?: number;
  missingEnglish?: number;
  bilingual?: boolean;
  /** The deployment's summary language; the board switch and the tag name it. */
  summaryLanguage?: SummaryLanguage;
  /** The reader's theme and text size, read from the cookie before rendering. */
  appearance?: Appearance;
}

const SOURCE_LABELS: Record<string, string> = {
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  other: 'Post',
};

/**
 * The source menu, in the order the chips used to list it. `web` is a saved
 * page and `note` an agent's artifact, so the last two name a row's shape
 * rather than a platform.
 */
const SOURCE_FILTER_ITEMS: readonly { value: Exclude<SourceFilter, 'all'>; label: string }[] = [
  { value: 'x', label: 'X' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'web', label: 'Web' },
  { value: 'note', label: 'Artifact' },
];

/** The filter menus a pick can reopen; the URL's `menu` accepts only these. */
type FilterMenuKey = 'source' | 'folder' | 'labels';

interface FilterMenuOptions {
  key: FilterMenuKey;
  /** The group's name, on the trigger and at the top of the panel. */
  name: string;
  /** The chosen values, joined; empty when the group is not filtering. */
  value: string;
  isSet: boolean;
  /** The link that drops this group. */
  clearHref: string;
  /** The clear row's text, which is also the value when nothing is picked. */
  clearLabel: string;
  items: { href: string; label: string; count?: number; current: boolean }[];
}

/** Short source name for a bookmark URL, used as the outbound link label. */
function sourceName(url: string | null): string {
  return SOURCE_LABELS[sourceOfUrl(url)] || 'Post';
}

/**
 * Any AI job still writing for this bookmark: the summary, a new version of it,
 * or the English translation the reader is looking at. The page polls while a
 * card answers yes, so it has to count the same three jobs the old meta refresh
 * did — a finished summary with a version still queued is not done.
 */
function cardHasPendingJob(bookmark: Bookmark, lang: 'tr' | 'en'): boolean {
  return (
    ['pending', 'working'].includes(bookmark.summaryStatus || '') ||
    ['pending', 'working'].includes(bookmark.versionStatus || '') ||
    (lang === 'en' && ['pending', 'working'].includes(bookmark.summaryEnStatus || ''))
  );
}

/** Trim a repeated filter parameter: blanks dropped, repeats kept once. */
function uniquePicks(values: readonly string[]): string[] {
  const picks: string[] = [];
  for (const value of values) {
    const pick = String(value ?? '').trim();
    if (pick && !picks.includes(pick)) picks.push(pick);
  }
  return picks;
}

/**
 * A pick toggles: the value joins the group when it is absent and leaves it
 * when it is already picked, so two sources or two folders sit in one cut.
 */
function togglePick<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter(entry => entry !== value)
    : [...values, value];
}

/**
 * `“a”`, `“a” or “b”`, `“a”, “b” or “c”` — an empty state that names every
 * pick instead of only the first. Names are escaped here, so callers pass the
 * stored text as it is.
 */
function quotedNames(names: readonly string[]): string {
  const quoted = names.map(name => `“${escapeHtml(name)}”`);
  if (quoted.length <= 1) return quoted[0] || '';
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/**
 * Build a library/topic URL without empty or default parameters. A filter that
 * accepts several picks emits one parameter per pick (`label=a&label=b`), and
 * the order is fixed — `q`, `day`, `label…`, `view`, `lang`, `layout`,
 * `source…`, `topic…`, `menu` — so a single pick produces the same URL it
 * always did, and the menu key a pick came from stays last.
 */
function libraryHref(
  path: string,
  {
    query = '',
    day = null,
    labels = [],
    view = 'active',
    lang = 'tr',
    layout = 'saves',
    sources = [],
    topics = [],
    menu = null,
  }: {
    query?: string;
    day?: string | null;
    labels?: readonly string[];
    view?: 'active' | 'archived';
    lang?: 'tr' | 'en';
    layout?: 'folders' | 'saves';
    sources?: readonly SourceFilter[];
    topics?: readonly string[];
    menu?: string | null;
  } = {},
): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (day) params.set('day', day);
  for (const label of new Set(labels)) if (label) params.append('label', label);
  if (view === 'archived') params.set('view', 'archived');
  if (lang === 'en') params.set('lang', 'en');
  if (layout === 'folders') params.set('layout', 'folders');
  for (const source of new Set(sources)) {
    if (source !== 'all') params.append('source', source);
  }
  for (const topic of new Set(topics)) if (topic) params.append('topic', topic);
  if (menu) params.set('menu', menu);
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
  labels = [],
  label: labelOption = null,
  labelPicks: labelPicksOption = [],
  topicPicks: topicPicksOption = [],
  notice,
  error,
  aiConfigured = false,
  view: viewOption = 'active',
  lang: langOption = 'tr',
  layout: layoutOption = 'saves',
  source: sourceOption = 'all',
  sources: sourcesOption = [],
  menu: menuOption = null,
  activeTotal = 0,
  archivedTotal = 0,
  missingEnglish = 0,
  bilingual = false,
  summaryLanguage: summaryLanguageOption = 'en',
  appearance = DEFAULT_APPEARANCE,
}: RenderPageOptions): string {
  const view = viewOption === 'archived' ? 'archived' : 'active';
  const lang = langOption === 'en' ? 'en' : 'tr';
  // The primary summary is written in the deployment's own language, so the
  // card's tag and the board switch name that, not a hardcoded Turkish.
  const summaryLanguage = String(summaryLanguageOption || 'en');
  const primaryTag = summaryLanguage === 'en' ? '' : summaryLanguage.split('-')[0].toUpperCase();
  const layout = layoutOption === 'folders' ? 'folders' : 'saves';
  const source = parseSource(sourceOption);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dayOption || '')) ? String(dayOption) : null;
  // One spelling feeds the other: the picks win when given, and the singular
  // option fills them in when a caller has not moved to arrays yet. `all` never
  // becomes a parameter, so an open cut renders no `source` at all.
  const sourcePicks: Exclude<SourceFilter, 'all'>[] = [];
  for (const value of sourcesOption.length ? sourcesOption : source === 'all' ? [] : [source]) {
    const pick = parseSource(value);
    if (pick !== 'all' && !sourcePicks.includes(pick)) sourcePicks.push(pick);
  }
  const labelPicks = uniquePicks(
    labelPicksOption.length ? labelPicksOption : labelOption ? [labelOption] : [],
  );
  const topicPicks = uniquePicks(topicPicksOption);
  // Only the three menu keys are honoured; anything else opens no panel.
  const openMenu: FilterMenuKey | null =
    menuOption === 'source' || menuOption === 'folder' || menuOption === 'labels'
      ? menuOption
      : null;
  const pending = bookmarks.some(bookmark => cardHasPendingJob(bookmark, lang));
  const path = topic ? `/t/${topic.slug}` : '/';
  const currentQuery = topic ? '' : query;
  const currentDay = topic ? null : day;
  // A folder page is its own path, so its links carry no folder parameter.
  const currentLabelPicks = topic ? [] : labelPicks;
  const currentTopicPicks = topic ? [] : topicPicks;
  const labelNames = currentLabelPicks.map(
    slug => labels.find(entry => entry.slug === slug)?.name || slug,
  );
  const topicNames = currentTopicPicks.map(
    slug => topics.find(entry => entry.slug === slug)?.name || slug,
  );
  const activeCount = (topic ? topic.count : activeTotal) ?? 0;
  const archivedCount = (topic ? topic.archivedCount : archivedTotal) ?? 0;
  /** Topic pages never carry the folder layout, so their links stay clean. */
  const layoutParam: 'folders' | 'saves' = topic ? 'saves' : layout;
  const returnTo = libraryHref(path, {
    query: currentQuery,
    day: currentDay,
    labels: currentLabelPicks,
    view,
    lang,
    layout: layoutParam,
    sources: sourcePicks,
    topics: currentTopicPicks,
  });
  // A menu is a named trigger carrying the current value, a panel of items that
  // toggle, and a clear row. Labels are the reader's tags, not folders — the
  // same shelf cut another way — so the label menu lists only labels somebody
  // actually used, while a folder list is the AI's own taxonomy.

  /**
   * A link inside the bar: the changes win over the page's own picks, every
   * other pick stays, and `menu` names the panel a pick came from so the reload
   * lands with it open. A clear row keeps the key too, so the panel survives the
   * clear and the reader can pick another value without opening it again.
   */
  const filterHref = (
    changes: {
      labels?: readonly string[];
      sources?: readonly SourceFilter[];
      topics?: readonly string[];
    } = {},
    menu: string | null = null,
  ): string =>
    libraryHref(path, {
      query: currentQuery,
      day: currentDay,
      labels: changes.labels ?? currentLabelPicks,
      view,
      lang,
      layout: layoutParam,
      sources: changes.sources ?? sourcePicks,
      topics: changes.topics ?? currentTopicPicks,
      menu,
    });
  const sourceFilterName = (value: SourceFilter): string =>
    SOURCE_FILTER_ITEMS.find(item => item.value === value)?.label || value;
  const filterMenu = (menu: FilterMenuOptions): string =>
    `<details class="filter-menu${menu.isSet ? ' is-set' : ''}"${openMenu === menu.key ? ' open' : ''}>
                  <summary><span class="filter-name">${escapeHtml(menu.name)}</span><span class="filter-value">${escapeHtml(
                    menu.value || menu.clearLabel,
                  )}</span><span class="caret" aria-hidden="true">▾</span></summary>
                  <div class="filter-panel">
                    <p class="filter-panel-head">${escapeHtml(menu.name)}</p>
                    <a href="${escapeHtml(menu.clearHref)}"${menu.isSet ? '' : ' aria-current="page"'}>${escapeHtml(
                      menu.clearLabel,
                    )}</a>
                    ${menu.items
                      .map(
                        item =>
                          `<a href="${escapeHtml(item.href)}"${
                            item.current ? ' aria-current="page"' : ''
                          }><span class="filter-label">${escapeHtml(item.label)}</span>${
                            item.count === undefined ? '' : `<span class="filter-count">${item.count}</span>`
                          }</a>`,
                      )
                      .join('\n                    ')}
                  </div>
                </details>`;
  const sourceMenu = filterMenu({
    key: 'source',
    name: 'Source',
    value: sourcePicks.map(sourceFilterName).join(', '),
    isSet: sourcePicks.length > 0,
    clearHref: filterHref({ sources: [] }, 'source'),
    clearLabel: 'All sources',
    items: SOURCE_FILTER_ITEMS.map(item => ({
      href: filterHref({ sources: togglePick(sourcePicks, item.value) }, 'source'),
      label: item.label,
      current: sourcePicks.includes(item.value),
    })),
  });
  // A folder page is one folder already, so it gets no folder menu there.
  const folderMenu =
    !topic && topics.length
      ? filterMenu({
          key: 'folder',
          name: 'Folder',
          value: topicNames.join(', '),
          isSet: currentTopicPicks.length > 0,
          clearHref: filterHref({ topics: [] }, 'folder'),
          clearLabel: 'All folders',
          items: topics.map(entry => ({
            href: filterHref({ topics: togglePick(currentTopicPicks, entry.slug) }, 'folder'),
            label: entry.name,
            count: entry.count,
            current: currentTopicPicks.includes(entry.slug),
          })),
        })
      : '';
  const labelMenuMarkup = labels.length
    ? filterMenu({
        key: 'labels',
        name: 'Labels',
        value: labelNames.join(', '),
        isSet: currentLabelPicks.length > 0,
        clearHref: filterHref({ labels: [] }, 'labels'),
        clearLabel: 'All labels',
        items: labels.map(entry => ({
          href: filterHref({ labels: togglePick(currentLabelPicks, entry.slug) }, 'labels'),
          label: entry.name,
          count: entry.count,
          current: currentLabelPicks.includes(entry.slug),
        })),
      })
    : '';
  // An active filter is a token with an ×: the bar stays one line, and the
  // reader can drop one pick without hunting for the menu that made it.
  const filterToken = (name: string, removeHref: string): string =>
    `<a class="filter-token" href="${escapeHtml(removeHref)}" aria-label="Remove the ${escapeHtml(
      name,
    )} filter">${escapeHtml(name)}<i aria-hidden="true">×</i></a>`;
  const filterTokens: string[] = [];
  for (const value of sourcePicks) {
    filterTokens.push(
      filterToken(
        sourceFilterName(value),
        filterHref({ sources: sourcePicks.filter(entry => entry !== value) }),
      ),
    );
  }
  for (const slug of currentTopicPicks) {
    filterTokens.push(
      filterToken(
        topics.find(entry => entry.slug === slug)?.name || slug,
        filterHref({ topics: currentTopicPicks.filter(entry => entry !== slug) }),
      ),
    );
  }
  for (const slug of currentLabelPicks) {
    filterTokens.push(
      filterToken(
        labels.find(entry => entry.slug === slug)?.name || slug,
        filterHref({ labels: currentLabelPicks.filter(entry => entry !== slug) }),
      ),
    );
  }
  const tokenRow = filterTokens.length
    ? `<div class="filter-tokens">
                  ${filterTokens.join('\n                  ')}
                  ${
                    filterTokens.length > 1
                      ? `<a class="clear-filters" href="${escapeHtml(
                          filterHref({ labels: [], sources: [], topics: [] }),
                        )}">Clear filters</a>`
                      : ''
                  }
                </div>`
    : '';
  const noticeText = notice ? NOTICES[notice] : '';
  const addValue = escapeHtml(query || '');
  const showTranslateBanner =
    lang === 'en' && bilingual && aiConfigured && missingEnglish > 0;
  const dayLabel = currentDay ? formatDate(`${currentDay}T00:00:00.000Z`) : '';
  const calendarHref = lang === 'en' ? '/calendar?lang=en' : '/calendar';
  const showingList =
    !topic &&
    (layout === 'saves' ||
      Boolean(currentQuery) ||
      Boolean(currentDay) ||
      currentLabelPicks.length > 0 ||
      currentTopicPicks.length > 0);
  const showFolders = !topic && !showingList && topics.length > 0;

  const folderTopics = [...topics].sort((left, right) => {
    const leftCount = (view === 'archived' ? left.archivedCount : left.count) ?? 0;
    const rightCount = (view === 'archived' ? right.archivedCount : right.count) ?? 0;
    return rightCount - leftCount || left.name.localeCompare(right.name, 'tr');
  });

  // Two picks must not read as one: the eyebrow counts the cut ("2 labels")
  // and the heading names every one of them.
  const cutKinds = [
    labelNames.length === 1 ? 'Label' : labelNames.length ? `${labelNames.length} labels` : '',
    topicNames.length === 1 ? 'Folder' : topicNames.length ? `${topicNames.length} folders` : '',
  ].filter(Boolean);
  const cutEyebrow = cutKinds.length
    ? `${cutKinds.join(' and ')} · ${activeCount} active${archivedCount ? ` · ${archivedCount} archived` : ''}`
    : '';

  const eyebrow = topic
    ? `Folder · ${activeCount} active${archivedCount ? ` · ${archivedCount} archived` : ''}`
    : showFolders
      ? `${view === 'archived' ? 'Archive' : 'Library'} · ${folderTopics.length} ${
          folderTopics.length === 1 ? 'folder' : 'folders'
        }`
      : currentDay
        ? `Day · ${activeCount} active${archivedCount ? ` · ${archivedCount} archived` : ''}`
        : cutEyebrow
          ? cutEyebrow
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
        : labelNames.length
          ? labelNames.map(escapeHtml).join(', ')
          : topicNames.length
            ? topicNames.map(escapeHtml).join(', ')
            : showFolders
              ? 'Browse by folder'
              : view === 'archived'
                ? 'Archived bookmarks'
                : 'Latest saves';

  return pageShell({
    title: topic
      ? `${topic.name} · Shelf`
      : labelNames.length
        ? `${labelNames.join(', ')} · Shelf`
        : topicNames.length
          ? `${topicNames.join(', ')} · Shelf`
          : showFolders
            ? 'Folders · Shelf'
            : currentDay
              ? `${dayLabel} · Shelf`
              : view === 'archived'
                ? 'Archive · Shelf'
                : 'Shelf',
    bodyClass: 'home',
    head: pending ? '<noscript><meta http-equiv="refresh" content="4"></noscript>' : '',
    look: appearance,
    body: `
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark">${BRAND_MARK}</span>
          <span>Shelf</span>
        </a>
        <div class="top-actions">
          <a class="bar-icon" href="${escapeHtml(calendarHref)}" aria-label="Open the save calendar" title="Calendar">${CALENDAR_MARK}</a>
          <a class="calendar-link" href="/settings">Settings</a>
          <form method="post" action="/logout">
            <button class="link-button" type="submit">Log out</button>
          </form>
        </div>
      </header>

      <main class="shell">
        <details class="add-drawer">
          <summary><span class="add-icon">+</span> Save a link from X, LinkedIn, YouTube or any page</summary>
          <form class="add-form" method="post" action="/add">
            <label class="sr-only" for="url">Post URL</label>
            <input id="url" name="url" type="url" inputmode="url" autocomplete="off" placeholder="https://x.com/user/status/… · linkedin.com/posts/… · youtu.be/… · example.com/blog/…" required value="${addValue}">
            <button type="submit">Save post</button>
          </form>
          <p class="fine-print">On Android: <strong>Share → Shelf</strong> from X, LinkedIn, YouTube or any browser page. The post, page, quote, article, links, video and images are read and summarized automatically.</p>
        </details>

        ${noticeText ? `<div class="banner success">${escapeHtml(noticeText)}</div>` : ''}
        ${error ? `<div class="banner error">${escapeHtml(truncate(error, 400))}</div>` : ''}

        <section class="library" id="library">
          ${
            topic
              ? `<nav class="folder-crumbs" aria-label="Folders">
                  <a href="${escapeHtml(libraryHref('/', { view, lang, layout: 'folders', sources: sourcePicks }))}">← All folders</a>
                </nav>`
              : ''
          }
          <div class="library-head">
            <div>
              <p class="eyebrow">${escapeHtml(eyebrow)}</p>
              <h2>${heading}</h2>
            </div>
            <div class="library-tools">
              <form class="search-form" method="get" action="/">
                ${currentDay ? `<input type="hidden" name="day" value="${escapeHtml(currentDay)}">` : ''}
                ${currentLabelPicks
                  .map(pick => `<input type="hidden" name="label" value="${escapeHtml(pick)}">`)
                  .join('')}
                ${view === 'archived' ? '<input type="hidden" name="view" value="archived">' : ''}
                ${lang === 'en' ? '<input type="hidden" name="lang" value="en">' : ''}
                ${sourcePicks
                  .map(pick => `<input type="hidden" name="source" value="${escapeHtml(pick)}">`)
                  .join('')}
                ${currentTopicPicks
                  .map(pick => `<input type="hidden" name="topic" value="${escapeHtml(pick)}">`)
                  .join('')}
                ${!topic && layout === 'folders' ? '<input type="hidden" name="layout" value="folders">' : ''}
                <label class="sr-only" for="q">Search bookmarks</label>
                <input id="q" name="q" type="search" placeholder="Search text or author" value="${escapeHtml(query || '')}">
                <button type="submit">Search</button>
                ${query ? `<a class="clear-search" href="${escapeHtml(libraryHref(path, { day: currentDay, labels: currentLabelPicks, view, lang, layout: layoutParam, sources: sourcePicks, topics: currentTopicPicks }))}">Clear</a>` : ''}
              </form>
              <div class="library-bar">
                <div class="library-switches">
                  ${
                    !topic && topics.length
                      ? `<nav class="view-switch layout-switch" role="group" aria-label="Library layout">
                          <a class="${showingList ? 'active' : ''}" href="${escapeHtml(
                            libraryHref('/', { labels: currentLabelPicks, view, lang, layout: 'saves', sources: sourcePicks, topics: currentTopicPicks }),
                          )}">All saves<span>${view === 'archived' ? archivedCount : activeCount}</span></a>
                          <a class="${showingList ? '' : 'active'}" href="${escapeHtml(
                            libraryHref('/', { view, lang, layout: 'folders', sources: sourcePicks }),
                          )}">Folders<span>${folderTopics.length}</span></a>
                        </nav>`
                      : ''
                  }
                  <nav class="view-switch" role="group" aria-label="Archive filter">
                    <a class="${view === 'active' ? 'active' : ''}" href="${escapeHtml(
                      libraryHref(path, { query: currentQuery, day: currentDay, labels: currentLabelPicks, view: 'active', lang, layout: layoutParam, sources: sourcePicks, topics: currentTopicPicks }),
                    )}">Active<span>${activeCount}</span></a>
                    <a class="${view === 'archived' ? 'active' : ''}" href="${escapeHtml(
                      libraryHref(path, { query: currentQuery, day: currentDay, labels: currentLabelPicks, view: 'archived', lang, layout: layoutParam, sources: sourcePicks, topics: currentTopicPicks }),
                    )}">Archived<span>${archivedCount}</span></a>
                  </nav>
                  ${sourceMenu}
                  ${folderMenu}
                  ${labelMenuMarkup}
                  ${
                    bilingual
                      ? `<nav class="lang-switch" role="group" aria-label="Summary language">
                          <a class="${lang === 'tr' ? 'active' : ''}" href="${escapeHtml(
                            libraryHref(path, { query: currentQuery, day: currentDay, labels: currentLabelPicks, view, lang: 'tr', layout: layoutParam, sources: sourcePicks, topics: currentTopicPicks }),
                          )}">${escapeHtml(languageOf(summaryLanguage).native)}</a>
                          <a class="${lang === 'en' ? 'active' : ''}" href="${escapeHtml(
                            libraryHref(path, { query: currentQuery, day: currentDay, labels: currentLabelPicks, view, lang: 'en', layout: layoutParam, sources: sourcePicks, topics: currentTopicPicks }),
                          )}">English</a>
                        </nav>`
                      : ''
                  }
                </div>
                ${tokenRow}
              </div>
            </div>
          </div>

          ${
            currentDay
              ? `<div class="day-banner">
                  <span>Showing ${total} ${view === 'archived' ? 'archived' : 'active'} of ${activeCount + archivedCount} ${activeCount + archivedCount === 1 ? 'save' : 'saves'} from <strong>${escapeHtml(dayLabel)}</strong>.</span>
                  <a href="${escapeHtml(libraryHref(path, { query: currentQuery, labels: currentLabelPicks, view, lang, layout: layoutParam, sources: sourcePicks, topics: currentTopicPicks }))}">Clear date</a>
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
                      : `<p class="topic-overview-empty">The synthesis for this folder is still being written.</p>`
                  }
                  ${
                    lang === 'en' && topic.overview
                      ? '<p class="topic-language-note">Folder syntheses are written in the summary language.</p>'
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

          ${
            showFolders
              ? renderFolderGrid(folderTopics, { view, lang, sources: sourcePicks })
              : layout === 'folders' && !topic && !currentQuery && !currentDay
                ? `<p class="folder-hint">Folders form themselves once a few saves have been summarized. Until then, the latest saves are below.</p>`
                : ''
          }

          ${
            showFolders
              ? ''
              : bookmarks.length
                ? `<div class="cards">${bookmarks
                    .map(bookmark =>
                      renderBookmark(bookmark, aiConfigured, returnTo, lang, bilingual, view, labels, primaryTag),
                    )
                    .join('')}</div>`
                : currentLabelPicks.length && !query
                  ? `<div class="empty">
                      <p class="empty-mark">⌁</p>
                      <h3>Nothing ${view === 'archived' ? 'archived ' : ''}carries ${quotedNames(
                        labelNames,
                      )}</h3>
                      <p>${
                        view === 'archived'
                          ? `A label only lists what it is put on, and ${
                              labelNames.length === 1 ? 'this one is' : 'these are'
                            } not on an archived save yet.`
                          : `Every save that carries ${
                              labelNames.length === 1 ? 'it' : 'them'
                            } is archived, or the ${
                              labelNames.length === 1 ? 'label was' : 'labels were'
                            } changed from a card.`
                      }</p>
                      <a class="small-button" href="${escapeHtml(
                        libraryHref('/', { labels: currentLabelPicks, view: view === 'archived' ? 'active' : 'archived', lang, sources: sourcePicks, topics: currentTopicPicks }),
                      )}">${view === 'archived' ? 'Look in the active saves' : 'Look in the archive'}</a>
                      <a class="small-button" href="${escapeHtml(
                        libraryHref('/', { view, lang, layout: 'saves', sources: sourcePicks, topics: currentTopicPicks }),
                      )}">All labels</a>
                    </div>`
                  : renderEmpty(query, view, currentDay, topic ? 1 : currentTopicPicks.length, sourcePicks, layout)
          }

          ${
            !showFolders && total > bookmarks.length
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
        <a href="${ANDROID_APP_PAGE}" rel="noopener">Android app</a>
      </footer>
    `,
  });
}

export interface RenderCalendarOptions {
  calendar: CalendarResult;
  lang?: 'tr' | 'en';
  error?: string | null;
  appearance?: Appearance;
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
  appearance = DEFAULT_APPEARANCE,
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
    title: `${label} · Calendar · Shelf`,
    bodyClass: 'home calendar-page',
    head: '',
    look: appearance,
    body: `
      <header class="topbar">
        <a class="brand" href="${escapeHtml(libraryHref('/', { lang }))}">
          <span class="brand-mark">${BRAND_MARK}</span>
          <span>Shelf</span>
        </a>
        <div class="top-actions">
          <span class="count">${calendar.total} saved this month</span>
          <a class="calendar-link" href="/settings">Settings</a>
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

function renderFolderGrid(
  topics: TopicSummary[],
  {
    view,
    lang,
    sources,
  }: { view: 'active' | 'archived'; lang: 'tr' | 'en'; sources: readonly SourceFilter[] },
): string {
  return `<div class="folder-grid" aria-label="Folders">${topics
    .map(entry => {
      const count = (view === 'archived' ? entry.archivedCount : entry.count) ?? 0;
      const archived = entry.archivedCount ?? 0;
      const meta =
        view === 'archived'
          ? `${count} archived`
          : `${count} ${count === 1 ? 'save' : 'saves'}${archived ? ` · ${archived} archived` : ''}`;
      return `
        <a class="folder-card" href="${escapeHtml(libraryHref(`/t/${entry.slug}`, { view, lang, sources }))}">
          <span class="folder-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
              <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2h7A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>
            </svg>
          </span>
          <span class="folder-copy">
            <span class="folder-name">${escapeHtml(entry.name)}</span>
            ${entry.description ? `<span class="folder-desc">${escapeHtml(entry.description)}</span>` : ''}
            <span class="folder-meta">${escapeHtml(meta)}</span>
          </span>
          <span class="folder-arrow" aria-hidden="true">→</span>
        </a>
      `;
    })
    .join('')}</div>`;
}

/**
 * The release history, `/changelog`. A document page rather than a card list:
 * one column, a date per release, the changes under it. The copy is English
 * like the rest of the Worker; the language only decides how a date is written.
 */
export function renderChangelogPage({
  entries,
  lang = 'en',
  appearance = DEFAULT_APPEARANCE,
}: {
  entries: ChangelogEntry[];
  lang?: UiLang;
  appearance?: Appearance;
}): string {
  const list = entries.length
    ? entries
        .map(
          entry => `<article class="release">
            <h2><time datetime="${escapeHtml(entry.date)}">${escapeHtml(
              formatChangelogDate(entry.date, lang),
            )}</time></h2>
            <ul>${entry.bullets
              .map(bullet => `<li>${renderChangelogBullet(bullet)}</li>`)
              .join('')}</ul>
          </article>`,
        )
        .join('\n          ')
    : '<p class="lede">Every change a deploy carries gets a line here. Nothing is published yet.</p>';

  return pageShell({
    title: 'Changelog · Shelf',
    bodyClass: 'home changelog-page',
    head: '',
    look: appearance,
    body: `
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark">${BRAND_MARK}</span>
          <span>Shelf</span>
        </a>
        <div class="top-actions">
          <a class="bar-icon" href="/calendar" aria-label="Open the save calendar" title="Calendar">${CALENDAR_MARK}</a>
          <a class="calendar-link" href="/settings">Settings</a>
          <form method="post" action="/logout">
            <button class="link-button" type="submit">Log out</button>
          </form>
        </div>
      </header>

      <main class="shell">
        <section class="library changelog">
          <p class="eyebrow">Changelog</p>
          <h1>What a deploy carried</h1>
          <p class="lede">Every change a deploy carries gets a line here, under the day it shipped. Newest first.</p>
          ${list}
          <p class="settings-foot"><a href="/">← Back to the library</a></p>
        </section>
      </main>
    `,
  });
}

/**
 * Full reading view for an agent note (`/p/:ref`). The note is the page: one
 * slim bar, one provenance line, then the document. An HTML note already has a
 * title in its own markup, so the page does not repeat it — it only keeps the
 * abstract a click away.
 */
export function renderNotePage({
  bookmark,
  appearance = DEFAULT_APPEARANCE,
}: {
  bookmark: Bookmark;
  appearance?: Appearance;
}): string {
  const title = bookmark.title || 'Untitled note';
  const agent = bookmark.agent;
  const agentName = agent?.name?.trim() || 'AI agent';
  const model = agent?.model?.trim() || '';
  const byline = [agentName, model, formatDate(bookmark.savedAt)]
    .filter(Boolean)
    .join(' · ');
  const sourceUrl = safeHttpUrl(bookmark.sourceUrl || '');
  const isHtml = bookmark.format === 'html';
  const ref = bookmark.ref ? `#${bookmark.ref}` : '';
  const abstract = bookmark.summary
    ? `<section class="note-abstract"><span class="note-label">Abstract</span>${renderParagraphs(
        bookmark.summary,
      )}</section>`
    : '';
  const body = isHtml
    ? `<iframe class="note-frame note-frame-full" src="/p/${escapeHtml(bookmark.ref)}/frame" title="${escapeHtml(
        title,
      )}" sandbox referrerpolicy="no-referrer"></iframe>`
    : `<div class="note-body note-body-full">${renderMarkdown(
        stripDuplicateHeading(bookmark.content || '', title),
      )}</div>`;

  return pageShell({
    title: `${title} · Shelf`,
    bodyClass: 'note-page',
    head: '',
    look: appearance,
    body: `
      <header class="note-bar">
        <a class="note-back" href="/">← Library</a>
        <div class="note-bar-side">
          <span class="ai-badge" title="Written by an AI agent">AI-generated</span>
          ${
            sourceUrl
              ? `<a class="note-source" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Source ↗</a>`
              : ''
          }
        </div>
      </header>

      <main class="shell note-shell">
        ${
          isHtml
            ? `<h1 class="sr-only">${escapeHtml(title)}</h1>
              <p class="note-byline">
                ${escapeHtml(byline)}
                ${ref ? `<span class="dot">·</span> ${escapeHtml(ref)}` : ''}
              </p>
              ${
                bookmark.summary
                  ? `<details class="note-abstract-fold">
                      <summary><span>Abstract</span><span class="note-fold-hint">agent-written</span></summary>
                      ${renderParagraphs(bookmark.summary)}
                    </details>`
                  : ''
              }
              ${body}`
            : `<article class="note-article">
                <h1 class="note-title">${escapeHtml(title)}</h1>
                <p class="note-byline">
                  ${escapeHtml(byline)}
                  ${ref ? `<span class="dot">·</span> ${escapeHtml(ref)}` : ''}
                </p>
                ${abstract}
                ${body}
              </article>`
        }
      </main>
    `,
  });
}

export interface RenderSettingsOptions {
  settings: StoredSettings;
  ai: { provider: string; model: string; transport: string };
  aiConfigured: boolean;
  pushSubscriptions?: number;
  notice?: string | null;
  error?: string | null;
  appearance?: Appearance;
  /** The page's interface language; only English and Turkish have copy. */
  lang?: 'tr' | 'en';
}

const SETTINGS_NOTICES: Record<string, string> = {
  saved: 'Settings saved. New summaries will use them.',
  reset: 'The summary prompt is back to the built-in default.',
};

const TRANSPORT_LABELS: Record<string, string> = {
  http: 'OpenAI-compatible HTTP',
  anthropic: 'Anthropic Messages',
  workers: 'Workers AI binding',
  none: 'Not configured',
};

/**
 * One choice in a `.segmented` control. The pill is a submit button, so the
 * click is the save and the row needs no Save of its own. The note is the
 * `title`, so the control stays one row of words. `aria-pressed` says which
 * choice is on, and an `aria-label` is written only when the visible label is
 * too short to name the choice on its own (`S`, `M`, `L`, `XL`).
 */
function segmentedButton(
  name: string,
  value: string,
  label: string,
  note: string,
  selected: boolean,
  accessibleName = label,
): string {
  return `<button type="submit" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${
    selected ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"'
  } title="${escapeHtml(note)}"${
    accessibleName === label ? '' : ` aria-label="${escapeHtml(accessibleName)}"`
  }>${escapeHtml(label)}</button>`;
}

/**
 * A language's own name, followed by its English name when the two read
 * differently: a reader scanning for `Deutsch` should not have to know it is
 * filed under German.
 */
function languageOptionLabel(language: { native: string; english: string }): string {
  return language.native === language.english
    ? language.native
    : `${language.native} · ${language.english}`;
}

/**
 * The summary language menu, alphabetised by each language's own name, with the
 * saved tag kept as the first option when it is a typed variant the base list
 * does not carry (`pt-BR`, `sr-Latn`). Otherwise the current choice would be
 * invisible and a plain save would rewrite it to whatever the browser shows.
 */
function summaryLanguageOptions(saved: string, lang: 'tr' | 'en'): string {
  const offered = [...languageOptions()].sort((a, b) => a.native.localeCompare(b.native, lang));
  const key = saved.toLowerCase();
  const listed = offered.some(language => language.tag.toLowerCase() === key);
  const rows = listed ? offered : [languageOf(saved), ...offered];
  return rows
    .map(language => {
      const selected = language.tag.toLowerCase() === key ? ' selected' : '';
      return `<option value="${escapeHtml(language.tag)}"${selected}>${escapeHtml(
        languageOptionLabel(language),
      )}</option>`;
    })
    .join('\n                  ');
}

export function renderSettings({
  settings,
  ai,
  aiConfigured,
  pushSubscriptions = 0,
  notice,
  error,
  appearance = DEFAULT_APPEARANCE,
  lang = 'en',
}: RenderSettingsOptions): string {
  const customPrompt = Boolean(settings.summaryPrompt);
  const pushDetail =
    pushSubscriptions > 0
      ? `${pushSubscriptions} ${pushSubscriptions === 1 ? 'browser is' : 'browsers are'} subscribed.`
      : 'No browsers are subscribed yet.';
  const prompt = settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  const noticeText = notice ? SETTINGS_NOTICES[notice] : '';
  const limit = MAX_SUMMARY_PROMPT_LENGTH.toLocaleString('en-US');
  const count = prompt.length.toLocaleString('en-US');
  const transport = TRANSPORT_LABELS[ai.transport] || ai.transport;
  const whatsNew = latestChangelogBullets(CHANGELOG, 3);
  const newestRelease = CHANGELOG.length ? formatChangelogDate(CHANGELOG[0].date, lang) : '';

  return pageShell({
    title: 'Settings · Shelf',
    bodyClass: 'home settings-page',
    head: '',
    look: appearance,
    body: `
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark">${BRAND_MARK}</span>
          <span>Shelf</span>
        </a>
        <div class="top-actions">
          <a class="calendar-link" href="/">Library</a>
          <form method="post" action="/logout">
            <button class="link-button" type="submit">Log out</button>
          </form>
        </div>
      </header>

      <main class="shell">
        <section class="settings">
          <div class="settings-head">
            <p class="eyebrow">Settings</p>
            <h2>How Shelf reads and writes</h2>
            <p class="settings-lede">These preferences belong to this deployment. Summaries that already exist keep their text until you summarize them again.</p>
          </div>

          ${noticeText ? `<div class="banner success">${escapeHtml(noticeText)}</div>` : ''}
          ${error ? `<div class="banner error">${escapeHtml(truncate(error, 400))}</div>` : ''}

          <section class="settings-card" id="appearance">
            <div class="settings-card-head">
              <h3>Appearance</h3>
              <span class="settings-badge">This browser</span>
            </div>
            <div class="settings-row">
              <span class="settings-label" id="theme-label">Theme</span>
              <form class="segmented" method="post" action="/settings/appearance" aria-labelledby="theme-label">
                ${segmentedButton('theme', 'system', 'System', 'Follow the operating system.', appearance.theme === 'system')}
                ${segmentedButton('theme', 'light', 'Light', 'Always the light paper.', appearance.theme === 'light')}
                ${segmentedButton('theme', 'dark', 'Dark', 'Always the dark paper.', appearance.theme === 'dark')}
              </form>
            </div>
            <div class="settings-row">
              <span class="settings-label" id="size-label">Text size</span>
              <form class="segmented" method="post" action="/settings/appearance" aria-labelledby="size-label">
                ${segmentedButton('size', 'compact', 'S', 'Compact: 90% of the normal size.', appearance.size === 'compact', 'Compact')}
                ${segmentedButton('size', 'normal', 'M', 'Normal text size.', appearance.size === 'normal', 'Normal')}
                ${segmentedButton('size', 'large', 'L', 'Large: 110% of the normal size.', appearance.size === 'large', 'Large')}
                ${segmentedButton('size', 'xlarge', 'XL', 'Extra large: 120% of the normal size.', appearance.size === 'xlarge', 'Extra large')}
              </form>
            </div>
            <p class="settings-note">This is a browser setting, not an account one: it is kept in a cookie, so the phone and the desktop can differ. It saves as soon as you pick a choice.</p>
          </section>

          <form method="post" action="/settings" class="settings-form">
            <section class="settings-card">
              <div class="settings-card-head">
                <h3>Summary prompt</h3>
                <span class="settings-badge${customPrompt ? ' is-custom' : ''}">${customPrompt ? 'Custom' : 'Built-in'}</span>
              </div>
              <p class="settings-note">The instruction the AI follows for every new summary. <code>{{language}}</code> is replaced with the language below. Keep the built-in text — or clear the box — to use the default.</p>
              <label class="sr-only" for="summary_prompt">Summary prompt</label>
              <textarea id="summary_prompt" name="summary_prompt" data-prompt-source rows="14" maxlength="${MAX_SUMMARY_PROMPT_LENGTH}" spellcheck="true">${escapeHtml(prompt)}</textarea>
              <div class="settings-meta">
                <span><span data-prompt-count>${count}</span> / ${limit} characters</span>
                <span>${customPrompt ? 'Custom prompt' : 'Built-in prompt'}</span>
              </div>
            </section>

            <section class="settings-card">
              <div class="settings-card-head">
                <h3>Summary language</h3>
                <span class="settings-badge is-on">${escapeHtml(languageOf(settings.summaryLanguage).native)}</span>
              </div>
              <p class="settings-note">New summaries are written in this language. Any language other than English also gets an English version for the language switch. Summaries that already exist keep their text until you summarize them again.</p>
              <label class="sr-only" for="summary_language">Summary language</label>
              <select id="summary_language" name="summary_language">
                  ${summaryLanguageOptions(settings.summaryLanguage, lang)}
              </select>
              <div class="settings-field">
                <label class="settings-label" for="summary_language_typed">Or type a language</label>
                <input id="summary_language_typed" name="summary_language_typed" type="text" maxlength="${LANGUAGE_TAG_MAX}" placeholder="Deutsch, pt-BR, sr-Latn" autocomplete="off" spellcheck="false">
              </div>
              <p class="settings-note">A name (<code>Deutsch</code>) or a tag (<code>pt-BR</code>, <code>sr-Latn</code>) typed here wins over the list. Leave it empty to keep the option chosen above.</p>
            </section>

            <section class="settings-card">
              <div class="settings-card-head">
                <h3>AI</h3>
                <span class="settings-badge${aiConfigured ? ' is-on' : ''}">${aiConfigured ? 'Configured' : 'Not configured'}</span>
              </div>
              <dl class="settings-facts">
                <div><dt>Provider</dt><dd>${escapeHtml(ai.provider || (aiConfigured ? 'inferred' : 'none'))}</dd></div>
                <div><dt>Model</dt><dd>${escapeHtml(ai.model || '—')}</dd></div>
                <div><dt>Connection</dt><dd>${escapeHtml(transport)}</dd></div>
              </dl>
              <p class="settings-note">${aiConfigured ? 'The API key lives in Worker secrets; it is never shown or edited here.' : 'No AI is configured yet. Set <code>AI_PROVIDER</code> and a key, or bind Workers AI, then redeploy.'} Change the provider or model in the Worker configuration.</p>
            </section>

            <section class="settings-card settings-card-muted" data-push>
              <div class="settings-card-head">
                <h3>Notifications</h3>
                <span class="settings-badge" data-push-badge>Checking</span>
              </div>
              <p class="settings-note">Get a notification when a summary finishes. On the web, your browser asks for permission; in the Android app, Shelf checks in the background and posts a system notification.</p>
              <p class="settings-note" data-push-state>Checking this browser…</p>
              <div class="settings-actions">
                <button class="secondary" type="button" data-push-enable hidden>Enable notifications</button>
                <button class="secondary" type="button" data-push-disable hidden>Disable notifications</button>
                <button class="secondary" type="button" data-push-test hidden>Send a test notification</button>
              </div>
              <p class="fine-print" data-push-detail>${escapeHtml(pushDetail)}</p>
            </section>

            <div class="settings-actions settings-actions-foot">
              <button type="submit" name="action" value="save">Save settings</button>
              ${customPrompt ? '<button class="secondary" type="submit" name="action" value="reset" formnovalidate>Reset prompt to default</button>' : ''}
            </div>
          </form>

          ${
            whatsNew.length
              ? `<section class="settings-card" id="whats-new">
            <div class="settings-card-head">
              <h3>What's new</h3>
              <span class="settings-badge">${escapeHtml(newestRelease)}</span>
            </div>
            <ul class="settings-changelog">
              ${whatsNew.map(bullet => `<li>${renderChangelogBullet(bullet)}</li>`).join('\n              ')}
            </ul>
            <p class="settings-changelog-more"><a href="/changelog">Read the changelog</a></p>
          </section>`
              : ''
          }

          <p class="settings-foot"><a href="/">← Back to the library</a></p>
        </section>
      </main>
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

/**
 * A card's labels are both a view of the shelf and the way back to one: a chip
 * links to that label's list, and the editor is a tick list of the labels the
 * page already knows, because the set is chosen rather than typed. The form
 * carries `returnTo` so saving never loses the search, day, archive or label
 * view. A tick posts the set; `+ New label` is a chip in the same row, so the
 * name field is only in the page while it is being used. Without a script the
 * checklist needs a button of its own, so one sits inside <noscript>.
 */
function renderLabels(
  bookmark: Bookmark,
  returnTo: string,
  view: 'active' | 'archived',
  lang: 'tr' | 'en',
  pageLabels: LabelSummary[] = [],
): string {
  const carried = bookmark.labels || [];
  const names = carried.map(label => label.name);
  const carriedSlugs = new Set(carried.map(label => label.slug));
  const field = `new-label-${bookmark.tweetId}`;
  const chips = carried
    .map(
      label =>
        `<a class="label tone-${labelTone(label.slug)}" href="${escapeHtml(
          libraryHref('/', { labels: [label.slug], view, lang }),
        )}">${escapeHtml(label.name)}</a>`,
    )
    .join('');

  // A label this card carries can sit outside the page's list — a filtered view
  // only offers what the filter shows. It is added back here, because an
  // unticked box would submit as "remove" and saving would drop it silently.
  const offered = new Set(pageLabels.map(entry => entry.slug));
  const picks = [...pageLabels, ...carried.filter(label => !offered.has(label.slug))].sort(
    (a, b) => a.name.localeCompare(b.name, lang),
  );
  const boxes = picks
    .map(
      option =>
        `<label class="label-check"><input type="checkbox" name="label" value="${escapeHtml(
          option.name,
        )}"${carriedSlugs.has(option.slug) ? ' checked' : ''}><span>${escapeHtml(option.name)}</span></label>`,
    )
    .join('');

  return `<div class="card-labels">${chips}<details class="label-editor">
            <summary>${
              names.length
                ? `Labels <span class="label-count">${names.length}</span>`
                : '+ Label'
            }</summary>
            <form class="label-form" method="post" action="/labels">
              <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
              <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
              <fieldset class="label-picks">
                <legend class="sr-only">Labels</legend>
                ${boxes}
                <details class="label-new">
                  <summary>+ New label</summary>
                  <div class="label-new-row">
                    <label class="sr-only" for="${field}">New label name</label>
                    <input id="${field}" name="newLabel" placeholder="reading, design, later" autocomplete="off">
                    <button type="submit">Add</button>
                  </div>
                </details>
              </fieldset>
              <noscript><button type="submit" class="label-save">Save labels</button></noscript>
            </form>
          </details></div>`;
}

/**
 * The one control row a card carries: archive, remove, and the way out to the
 * source. It sits in the head next to the author, where the reader already
 * looks for what this card is, so the bottom of the card is content only — no
 * metric counts, no JSON link, no second copy of the same destination.
 */
function renderCardTools(
  tweetId: string,
  returnTo: string,
  archived: boolean,
  sourceLink: string,
): string {
  return `<div class="card-tools">
            <form method="post" action="/archive" class="inline-form">
              <input type="hidden" name="id" value="${escapeHtml(tweetId)}">
              <input type="hidden" name="archived" value="${archived ? '0' : '1'}">
              <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
              <button class="card-tool" type="submit">${archived ? 'Unarchive' : 'Archive'}</button>
            </form>
            <form method="post" action="/delete" class="inline-form">
              <input type="hidden" name="id" value="${escapeHtml(tweetId)}">
              <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
              <button class="card-tool danger" type="submit">Remove</button>
            </form>
            ${sourceLink}
          </div>`;
}

function renderBookmark(
  bookmark: Bookmark,
  aiConfigured: boolean,
  returnTo = '/',
  lang: 'tr' | 'en' = 'tr',
  bilingual = false,
  view: 'active' | 'archived' = 'active',
  labels: LabelSummary[] = [],
  primaryTag = '',
): string {
  if (bookmark.kind === 'note') return renderNoteCard(bookmark, returnTo, view, lang, labels);

  const author: Partial<Author> = bookmark.author ?? {};
  const handle = author.username ? `@${author.username}` : '';
  const displayName = author.name || handle || 'Unknown';
  const avatar = safeHttpUrl(author.avatarUrl);
  const initial = escapeHtml((author.name || author.username || '?').slice(0, 1).toUpperCase());
  const archived = Boolean(bookmark.archivedAt);
  const outboundUrl = safeHttpUrl(bookmark.url);
  // Only an https picture is drawn: the page is served over TLS, so an http
  // one would be blocked as mixed content, and anything else is not a picture.
  const posterUrl = safeHttpUrl(bookmark.posterUrl);
  const poster = posterUrl?.startsWith('https://')
    ? `<figure class="card-poster"><a href="${escapeHtml(outboundUrl || '#')}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(bookmark.posterAlt || '')}" loading="lazy" referrerpolicy="no-referrer"></a></figure>`
    : '';
  // A saved page is labelled by its site; a platform post by its platform.
  const source =
    bookmark.provider === 'web' && author.name
      ? truncate(author.name, 32)
      : sourceName(outboundUrl);

  const extras = [];
  if (bookmark.article) extras.push(bookmark.provider === 'web' ? 'Saved page' : 'X Article');
  const mediaCount = (bookmark.media ?? []).filter(item => safeHttpUrl(item.url)).length;
  const youtubeId = bookmark.provider === 'youtube' ? youtubeVideoId(bookmark.url) : null;
  if (mediaCount && !youtubeId) extras.push(`${mediaCount} ${mediaCount === 1 ? 'image' : 'images'}`);
  if (youtubeId) extras.push(bookmark.shorts ? 'Short' : 'video');
  if (bookmark.quote) extras.push('quoted post');
  const linkCount = (bookmark.links ?? []).length;
  if (linkCount) extras.push(`${linkCount} ${linkCount === 1 ? 'link' : 'links'}`);

  return `
    <article class="card is-collapsed${archived ? ' is-archived' : ''}" id="bookmark-${escapeHtml(bookmark.tweetId)}" data-ref="${escapeHtml(bookmark.ref || bookmark.tweetId)}" data-summary-status="${escapeHtml(bookmark.summaryStatus || '')}"${cardHasPendingJob(bookmark, lang) ? ' data-pending="1"' : ''}>
      <header class="card-head">
        <div class="author">
          ${
            avatar
              ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
              : `<span class="avatar avatar-fallback">${initial}</span>`
          }
          <div class="author-text">
            <div class="author-line">
              <strong>${escapeHtml(displayName)}</strong>
              ${author.verified ? '<span class="verified" title="Verified">✓</span>' : ''}
              ${handle ? `<span class="handle">${escapeHtml(handle)}</span>` : ''}
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
        ${renderCardTools(
          bookmark.tweetId,
          returnTo,
          archived,
          `<a class="x-link" href="${escapeHtml(outboundUrl || '#')}" target="_blank" rel="noopener noreferrer" aria-label="Open on ${escapeHtml(source)}">${escapeHtml(source)} ↗</a>`,
        )}
      </header>
      <div class="tweet-text">${linkifyText(bookmark.text)}</div>
      ${poster}

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

      ${bookmark.article ? renderArticle(bookmark.article, bookmark.provider === 'web') : ''}
      ${youtubeId ? renderYouTubeEmbed(bookmark, youtubeId) : renderMedia(bookmark.media, 'main')}
      ${bookmark.quote ? renderQuote(bookmark.quote) : ''}
      ${bookmark.links?.length ? renderLinks(bookmark.links) : ''}
      ${renderSummary(bookmark, aiConfigured, returnTo, lang, bilingual, primaryTag)}

      ${extras.length ? `<p class="peek-meta">${escapeHtml(extras.join(' · '))}</p>` : ''}

      ${renderLabels(bookmark, returnTo, view, lang, labels)}
    </article>
  `;
}

/**
 * An agent-written note on a library page. The author line stays as short as a
 * person's handle; the note title is the card's lede and the abstract sits in
 * plain body copy. A note is a document, not card copy, so its body is never
 * embedded here — the title and `Open artifact` both lead to `/p/:ref`.
 */
function renderNoteCard(
  bookmark: Bookmark,
  returnTo: string,
  view: 'active' | 'archived' = 'active',
  lang: 'tr' | 'en' = 'tr',
  labels: LabelSummary[] = [],
): string {
  const agent = bookmark.agent;
  const agentName = agent?.name?.trim() || 'AI agent';
  const archived = Boolean(bookmark.archivedAt);
  const sourceUrl = safeHttpUrl(bookmark.sourceUrl || '');
  const title = bookmark.title || 'Untitled note';
  const isHtml = bookmark.format === 'html';
  const href = `/p/${escapeHtml(bookmark.ref)}`;
  const abstract = bookmark.summary
    ? `<section class="note-abstract">
              <span class="note-label">Abstract</span>
              ${renderParagraphs(bookmark.summary)}
            </section>`
    : '';
  const preview =
    !bookmark.summary && bookmark.text
      ? `<p class="note-excerpt">${escapeHtml(truncate(bookmark.text, 260))}</p>`
      : '';

  return `
    <article class="card note-card${archived ? ' is-archived' : ''}" id="bookmark-${escapeHtml(bookmark.tweetId)}" data-ref="${escapeHtml(bookmark.ref || bookmark.tweetId)}" data-summary-status="${escapeHtml(bookmark.summaryStatus || '')}"${cardHasPendingJob(bookmark, lang) ? ' data-pending="1"' : ''}>
      <header class="card-head">
        <div class="author">
          <span class="avatar avatar-fallback note-avatar" aria-hidden="true">AI</span>
          <div class="author-text">
            <div class="author-line">
              <strong class="note-agent-name">${escapeHtml(agentName)}</strong>
            </div>
            <div class="meta">
              ${escapeHtml(formatDate(bookmark.savedAt))}
              ${
                bookmark.ref
                  ? `<button class="ref-chip" type="button" data-copy="${escapeHtml(bookmark.ref)}" title="Copy bookmark id" aria-label="Bookmark id ${escapeHtml(bookmark.ref)}, click to copy">#${escapeHtml(bookmark.ref)}</button>`
                  : ''
              }
              ${archived ? '<span class="archive-chip">Archived</span>' : ''}
            </div>
          </div>
        </div>
        ${renderCardTools(
          bookmark.tweetId,
          returnTo,
          archived,
          `<a class="x-link" href="${href}">Open artifact ↗</a>${
            sourceUrl
              ? `<a class="x-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Source ↗</a>`
              : `<span class="x-link note-kind" title="${isHtml ? 'HTML document' : 'Note'}">${isHtml ? 'HTML' : 'Note'}</span>`
          }`,
        )}
      </header>

      <h3 class="note-card-title"><a href="${href}">${escapeHtml(title)}</a></h3>

      ${abstract}
      ${preview}

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

      ${renderLabels(bookmark, returnTo, view, lang, labels)}
    </article>
  `;
}

/** Avoid showing the title twice when the markdown opens with the same H1. */
function stripDuplicateHeading(content: string, title: string): string {
  const match = /^\s{0,3}#\s+(.+?)\s*$/m.exec(content);
  if (!match) return content;
  const heading = match[1].replace(/[*_`]/g, '').trim().toLowerCase();
  if (heading !== title.trim().toLowerCase()) return content;
  return content.replace(match[0], '');
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

function renderArticle(article: XArticle, savedPage = false): string {
  const url = safeHttpUrl(article.url);
  const label = savedPage ? 'Saved page' : 'X Article';
  const title = article.title || label;
  return `
    <section class="linked-article">
      <div class="linked-article-head">
        <span class="quote-label">${label}</span>
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

/**
 * A YouTube player that waits for a tap. Its poster is a real link, so a page
 * without JavaScript — or a tap with a modifier key — still opens the video on
 * YouTube, while `app.js` swaps the link for the embed. Nothing is fetched from
 * YouTube until the reader asks for it.
 */
function renderYouTubeEmbed(bookmark: Bookmark, videoId: string): string {
  const poster = safeHttpUrl((bookmark.media ?? []).find(item => item.type === 'photo')?.url);
  const title = truncate(bookmark.text || 'YouTube video', 90);
  const label = `Play video: ${title}`;

  return `
    <div class="media-grid main media-count-1">
      <figure class="media-cell yt-cell${bookmark.shorts ? ' is-portrait' : ''}">
        <a class="yt-card" href="https://www.youtube.com/watch?v=${escapeHtml(videoId)}" data-youtube="${escapeHtml(videoId)}" data-title="${escapeHtml(title)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(label)}">
          ${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
          <span class="yt-play" aria-hidden="true"></span>
        </a>
      </figure>
    </div>`;
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

function renderTranscripts(transcripts: VideoTranscript[] | undefined): string {
  const done = (transcripts ?? []).filter(
    transcript => transcript.status === 'done' && transcript.text.trim(),
  );
  if (!done.length) return '';

  return `
    <details class="transcripts">
      <summary>Video transcript${done.length > 1 ? `s (${done.length})` : ''}</summary>
      ${done
        .map(
          transcript => `
            <div class="transcript">
              <div class="transcript-meta">
                ${transcript.source === 'youtube' ? 'YouTube' : 'X video'}
                <span class="dot">·</span>
                ${formatDuration(transcript.durationSec)}
                <span class="dot">·</span>
                ${escapeHtml((transcript.lang || 'unknown').toUpperCase())}
                <span class="dot">·</span>
                ${transcript.provider === 'supadata' ? 'Supadata' : 'Whisper'}
              </div>
              <div class="transcript-text">${linkifyText(transcript.text)}</div>
            </div>
          `,
        )
        .join('')}
    </details>
  `;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 1) return 'length unknown';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function renderSummary(
  bookmark: Bookmark,
  aiConfigured: boolean,
  returnTo = '/',
  lang: 'tr' | 'en' = 'tr',
  bilingual = false,
  primaryTag = '',
): string {
  const status = bookmark.summaryStatus || (aiConfigured ? 'pending' : 'needs_key');

  if (status === 'done' && bookmark.summary) {
    const versions = Array.isArray(bookmark.versions) ? bookmark.versions : [];
    const busy = ['pending', 'working'].includes(bookmark.versionStatus ?? '');
    const preferEnglish = bilingual && lang === 'en';
    const englishReady = Boolean(bookmark.summaryEn) && bookmark.summaryEnStatus === 'done';
    const englishBusy = ['pending', 'working'].includes(bookmark.summaryEnStatus ?? '');
    const englishFailed = bookmark.summaryEnStatus === 'failed';
    const useEnglish = preferEnglish && englishReady;
    const shownSummary = useEnglish ? String(bookmark.summaryEn) : bookmark.summary;
    const languageTag = useEnglish ? 'EN' : bilingual ? primaryTag : '';

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
        ? '<p class="summary-note">The English version is being written. The original summary is shown below.</p>'
        : englishFailed
          ? `<p class="summary-note error">English translation failed: ${escapeHtml(
              truncate(bookmark.summaryEnError || 'unknown error', 200),
            )}</p>${translateForm}`
          : useEnglish
            ? '<p class="summary-note">Translated from the original summary.</p>'
            : `<p class="summary-note">No English version yet. The original summary is shown below.</p>${translateForm}`
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
            ? '<p class="version-language-note">Alternative versions are in the original language.</p>'
            : ''
        }
        ${busy ? `<p class="version-note">Writing version ${versions.length + 2}…</p>` : ''}
        ${
          bookmark.versionError
            ? `<p class="version-note error">${escapeHtml(truncate(bookmark.versionError, 240))}</p>`
            : ''
        }

        ${renderTranscripts(bookmark.transcripts)}

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
          <p class="regen-note">The original summary stays as it is. Each request becomes a new version, written in the summary language.</p>
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

  if (status === 'disabled' && aiConfigured) {
    return `
      <section class="summary disabled">
        <div class="summary-head">
          <span class="summary-mark">AI</span>
          <h3>Summary waiting</h3>
        </div>
        <p class="summary-note">This post was saved while summaries were off. AI is configured now, so the queue writes it on its next pass; you can also start it now.</p>
        <form method="post" action="/summarize" class="summary-retry">
          <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <button class="small-button" type="submit">Try again</button>
        </form>
      </section>
    `;
  }

  if (status === 'needs_key') {
    return summaryNotConfigured();
  }

  if (status === 'idle') {
    return `
      <section class="summary disabled">
        <div class="summary-head">
          <span class="summary-mark">AI</span>
          <h3>Summary waiting</h3>
        </div>
        <p class="summary-note">Automatic summaries are off, so this save waits for you. Start one now, or turn summaries on in Settings and the queue writes it on its next pass.</p>
        <form method="post" action="/summarize" class="summary-retry">
          <input type="hidden" name="id" value="${escapeHtml(bookmark.tweetId)}">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <button class="small-button" type="submit">Start now</button>
        </form>
      </section>
    `;
  }

  return summaryNotConfigured();
}

/** No AI in this deployment, so no summary was ever possible for this save. */
function summaryNotConfigured(): string {
  return `
    <section class="summary disabled">
      <div class="summary-head">
        <span class="summary-mark">AI</span>
        <h3>Summary not configured</h3>
      </div>
      <p class="summary-note">Bind Workers AI as AI, or add an AI_API_KEY secret, to turn on automatic summaries.</p>
    </section>
  `;
}

function renderEmpty(
  query: string,
  view: 'active' | 'archived' = 'active',
  day: string | null = null,
  folders = 0,
  sources: readonly SourceFilter[] = [],
  layout: 'folders' | 'saves' = 'saves',
): string {
  if (query) {
    return `
      <div class="empty">
        <p class="empty-mark">∅</p>
        <h3>${view === 'archived' ? 'No matches in the archive' : 'No matches'}</h3>
        <p>Nothing ${view === 'archived' ? 'archived ' : ''}in the library matches “${escapeHtml(query)}”${day ? ' on this day' : ''}.</p>
        <a class="small-button" href="${escapeHtml(libraryHref('/', { day, view, layout, sources }))}">Clear search</a>
      </div>
    `;
  }

  if (folders > 0) {
    const many = folders > 1;
    return `
      <div class="empty">
        <p class="empty-mark">▢</p>
        <h3>${
          view === 'archived'
            ? many
              ? 'Nothing archived in these folders'
              : 'Nothing archived in this folder'
            : many
              ? 'Nothing in these folders yet'
              : 'Nothing in this folder yet'
        }</h3>
        <p>${
          view === 'archived'
            ? `Archive a bookmark from ${many ? 'these folders' : 'this folder'} to keep it here for later.`
            : 'Save a post and the filing step will put it in a folder that fits. You can also browse every save.'
        }</p>
        <a class="small-button" href="${escapeHtml(libraryHref('/', { view, layout: 'folders', sources }))}">Browse folders</a>
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

export function renderLogin({
  error,
  next,
  appearance = DEFAULT_APPEARANCE,
}: {
  error?: string | null;
  next?: string | null;
  appearance?: Appearance;
} = {}): string {
  return pageShell({
    title: 'Log in · Shelf',
    bodyClass: 'login-page',
    head: '',
    look: appearance,
    body: `
      <main class="login-wrap">
        <div class="login-card">
          <span class="brand-mark large">${BRAND_MARK}</span>
          <p class="eyebrow">Private library</p>
          <h1>Shelf</h1>
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

export function renderSetup({
  appearance = DEFAULT_APPEARANCE,
}: { appearance?: Appearance } = {}): string {
  return pageShell({
    title: 'Setup required',
    bodyClass: 'login-page',
    head: '',
    look: appearance,
    body: `
      <main class="login-wrap">
        <div class="login-card setup-card">
          <span class="brand-mark large">${BRAND_MARK}</span>
          <p class="eyebrow">One more step</p>
          <h1>Set a password</h1>
          <p class="lede">This app is locked until an <code>APP_PASSWORD</code> secret is set.</p>
          <pre>bun run setup</pre>
          <p class="fine-print">Then reload this page.</p>
        </div>
      </main>
    `,
  });
}

export function pageShell({
  title,
  bodyClass,
  head,
  body,
  look = DEFAULT_APPEARANCE,
}: {
  title: string;
  bodyClass: string;
  head: string;
  body: string;
  look?: Appearance;
}): string {
  return `<!doctype html>
<html lang="en"${appearanceAttributes(look)}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  ${themeColorMeta(look)}
  <meta name="description" content="A private, self-hosted reader for X and LinkedIn posts, quotes, and images.">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <title>${escapeHtml(title)}</title>
  <link rel="manifest" href="${assetUrl('manifest.webmanifest')}">
  <link rel="icon" href="${assetUrl('favicon.svg')}" type="image/svg+xml">
  <link rel="apple-touch-icon" href="${assetUrl('icon-192.png')}">
  <link rel="stylesheet" href="/style.css?v=35">
  ${head}
  <noscript><style>
    .card.is-collapsed .tweet-text,
    .card.is-collapsed .note-body,
    .card.is-collapsed .summary-text { display: block; overflow: visible; -webkit-line-clamp: unset; }
    .card.is-collapsed .media-grid,
    .card.is-collapsed .quote,
    .card.is-collapsed .link-stack,
    .card.is-collapsed .note-card .card-head { align-items: flex-start; }

.linked-article { display: block; }
    .peek-meta { display: none; }
  </style></noscript>
  <script src="/app.js?v=6" defer></script>
</head>
<body class="${escapeHtml(bodyClass)}">
  ${body}
</body>
</html>`;
}

const NOTE_STYLES = `.note-avatar { background: var(--ink); color: var(--bg); font-size: 0.625rem; font-weight: 700; letter-spacing: 0.04em; }
.ai-badge { display: inline-flex; align-items: center; padding: 2px 7px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); font-size: 0.625rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.note-kind { color: var(--muted); font-size: 0.6875rem; font-weight: 600; white-space: nowrap; }
.note-agent-name { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-card { position: relative; }
.note-card .card-head { margin-bottom: 12px; }
.note-card .card-head .author { align-items: flex-start; }
.note-card-title { margin: 0 0 10px; font-size: 1.3125rem; line-height: 1.28; font-weight: 650; letter-spacing: -0.024em; overflow-wrap: anywhere; }
.note-card-title a { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; color: var(--ink); text-decoration: none; }
.note-card-title a::after { content: ""; position: absolute; inset: 0; border-radius: var(--radius); }
.note-card:hover .note-card-title a { text-decoration: underline; text-underline-offset: 3px; }
.note-card .card-topics, .note-card .card-tools, .note-card .card-head a, .note-card .ref-chip,
.note-card .note-abstract, .note-card .note-body, .note-card .note-excerpt,
.note-card .note-body a, .note-card .note-body pre, .note-card .table-wrap { position: relative; z-index: 1; }
.note-label { display: block; margin: 0 0 4px; color: var(--faint); font-size: 0.625rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
.note-abstract { margin: 0 0 12px; }
.note-abstract p { margin: 0 0 8px; font-size: 0.9375rem; line-height: 1.62; overflow-wrap: anywhere; }
.note-abstract p:last-child { margin-bottom: 0; }
.note-body { margin: 0 0 12px; font-size: 0.9375rem; line-height: 1.62; overflow-wrap: anywhere; }
.note-body > :first-child { margin-top: 0; }
.note-body h1, .note-body h2, .note-body h3, .note-body h4 { margin: 18px 0 8px; line-height: 1.25; letter-spacing: -0.02em; }
.note-body h1 { font-size: 1.625rem; }
.note-body h2 { font-size: 1.375rem; }
.note-body h3 { font-size: 1.125rem; }
.note-body h4 { font-size: 0.9375rem; }
.note-body p, .note-body ul, .note-body ol, .note-body blockquote, .note-body pre, .note-body .table-wrap { margin: 0 0 12px; }
.note-body ul, .note-body ol { padding-left: 22px; }
.note-body li { margin: 4px 0; }
.note-body a { color: var(--accent-ink); }
.note-body code { padding: 1px 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); font-family: var(--mono); font-size: 0.9em; }
.note-body pre { padding: 14px 16px; overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }
.note-body pre code { padding: 0; border: 0; background: none; }
.note-body blockquote { padding: 2px 0 2px 14px; border-left: 3px solid var(--line-strong); color: var(--muted); }
.note-body img { display: block; max-width: 100%; height: auto; margin: 10px 0; border-radius: 12px; }
.note-body hr { margin: 18px 0; border: 0; border-top: 1px solid var(--line); }
.note-body .table-wrap { overflow-x: auto; }
.note-body table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.note-body th, .note-body td { padding: 7px 10px; border: 1px solid var(--line); text-align: left; }
.note-body th { background: var(--surface-soft); }
.note-excerpt { margin: 0 0 12px; color: var(--ink); font-size: 0.9375rem; line-height: 1.62; overflow-wrap: anywhere; }
.note-body-full { margin: 18px 0 0; font-size: 1rem; }
.note-bar { width: min(900px, calc(100% - 36px)); margin-inline: auto; padding: 18px 0 4px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.note-back { color: var(--muted); font-size: 0.8125rem; font-weight: 600; text-decoration: none; }
.note-back:hover { color: var(--ink); }
.note-bar-side { display: flex; align-items: center; gap: 12px; }
.note-source { color: var(--muted); font-size: 0.75rem; text-decoration: none; }
.note-source:hover { color: var(--ink); }
.note-shell { padding: 6px 0 60px; }
.note-title { margin: 0; font-size: clamp(1.625rem, 6.4vw, 2.125rem); line-height: 1.14; letter-spacing: -0.03em; overflow-wrap: anywhere; }
.note-byline { margin: 6px 0 16px; color: var(--muted); font-size: 0.75rem; }
.note-byline .dot { margin: 0 2px; }
.note-abstract-fold { margin: 0 0 14px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 12px; }
.note-abstract-fold summary { display: flex; align-items: baseline; gap: 8px; color: var(--faint); font-size: 0.625rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; cursor: pointer; list-style: none; }
.note-abstract-fold summary::-webkit-details-marker { display: none; }
.note-abstract-fold summary::after { content: "+"; margin-left: auto; font-size: 0.875rem; line-height: 1; }
.note-abstract-fold[open] summary::after { content: "−"; }
.note-fold-hint { color: var(--faint); font-size: 0.5625rem; font-weight: 600; letter-spacing: 0.04em; }
.note-abstract-fold p { margin: 9px 0 0; font-size: 0.90625rem; line-height: 1.6; overflow-wrap: anywhere; }
.note-frame { display: block; width: 100%; height: 420px; min-height: 320px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.note-frame-full { height: clamp(360px, calc(100dvh - 190px), 1000px); border-radius: 12px; }
@media (max-width: 650px) {
  .note-card-title { font-size: 1.1875rem; }
  .note-bar { width: min(100% - 24px, 900px); padding-top: 12px; }
  .note-shell { padding-bottom: 40px; }
  .note-title { font-size: clamp(1.5rem, 7vw, 1.875rem); }
  .note-frame-full { height: calc(100dvh - 160px); min-height: 320px; }
}`;

/**
 * A label's chip colour, one rule per tone. `labelTone` picks the number from
 * the slug, and the two tokens it paints with live in `src/brand.ts`, so a
 * theme swap recolours every chip without the page carrying a style attribute
 * (the CSP allows `style-src 'self'` only).
 */
const LABEL_TONE_CSS = Array.from({ length: LABEL_TONE_COUNT }, (_, index) => index + 1)
  .map(
    tone => `.label.tone-${tone} {
  border-color: color-mix(in srgb, var(--label-${tone}-ink) 34%, transparent);
  background: var(--label-${tone}-wash);
  color: var(--label-${tone}-ink);
}

.label.tone-${tone}:hover { border-color: var(--label-${tone}-ink); }`,
  )
  .join('\n');

/**
 * The stylesheet: the shared brand block first, then the rules that are
 * this Worker's own. The palette, the @font-face set and the mark live in
 * `src/brand.ts` and nowhere else; nothing below declares a token or a hex.
 */
export const CSS: string = `${BRAND_CSS}
* { box-sizing: border-box; }

/* The reader's text size, read once: every size below is in rem, so the whole
   page moves with this one number. The server writes data-size on <html> from
   the cookie and BRAND_CSS maps it to --text-scale; nothing here knows which
   choice is active. */
html {
  font-size: calc(16px * var(--text-scale));
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 1rem;
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
  font-family: var(--display);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.brand-mark {
  display: block;
  width: 28px;
  height: 28px;
  flex: none;
}

.brand-mark svg {
  display: block;
  width: 100%;
  height: 100%;
}

.brand-mark.large {
  width: 54px;
  height: 54px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--muted);
  font-size: 0.8125rem;
}

.count {
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  font-family: var(--mono);
  font-size: 0.71875rem;
}

.hero {
  padding: 84px 0 54px;
}

.eyebrow {
  margin: 0 0 12px;
  color: var(--accent);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1, h2, h3, p { margin-top: 0; }

/* Figtree is the voice on every surface, so headings take it directly and the
   component rules below only set size and tracking. */
h1, h2, h3 {
  font-family: var(--display);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.hero h1 {
  margin-bottom: 20px;
  font-family: var(--display);
  font-size: clamp(2.625rem, 8vw, 4.75rem);
  line-height: 1.02;
  letter-spacing: -0.025em;
  font-weight: 500;
}

.lede {
  max-width: 590px;
  margin-bottom: 30px;
  color: var(--muted);
  font-size: 1.0625rem;
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
  font-size: 0.9375rem;
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
  font-size: 0.75rem;
}

.fine-print strong { color: var(--muted); }

.banner {
  margin: 0 0 18px;
  padding: 12px 15px;
  border-radius: 12px;
  font-size: 0.875rem;
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
  font-family: var(--display);
  font-size: 1.5rem;
  letter-spacing: -0.01em;
  font-weight: 500;
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

/* The bar is its own row under the search: a menu trigger carries the current
   value, and only an open panel takes space, so a hundred labels never add a
   second chip row. */
.library-bar {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
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
  font-size: 0.75rem;
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
  font-size: 0.65625rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.65;
}

/* One bar of named menus. The trigger carries the current value, and only the
   open menu takes space, so a long label list stays one row. */
.filter-menu { position: relative; }

.filter-menu > summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  min-height: 30px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  list-style: none;
}

.filter-menu > summary::-webkit-details-marker { display: none; }

.filter-menu > summary:hover,
.filter-menu[open] > summary { border-color: var(--line-strong); color: var(--ink); }

.filter-menu.is-set > summary { border-color: var(--line-strong); }

.filter-menu .filter-value {
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-menu.is-set .filter-value { color: var(--ink); }

.filter-menu .caret {
  color: var(--faint);
  font-size: 0.625rem;
  line-height: 1;
  transition: transform 0.12s ease;
}

.filter-menu[open] .caret { transform: rotate(180deg); }

.filter-panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  right: 0;
  width: min(15rem, calc(100vw - 32px));
  max-height: min(60vh, 20rem);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow);
}

.filter-panel-head {
  margin: 4px 8px 6px;
  color: var(--faint);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.filter-panel a {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  color: var(--ink);
  font-size: 0.8125rem;
  text-decoration: none;
}

.filter-panel a:hover { background: var(--surface-soft); }

.filter-panel a[aria-current] {
  background: var(--surface-soft);
  font-weight: 650;
}

.filter-panel a[aria-current]::after {
  content: '✓';
  color: var(--accent);
  font-weight: 700;
}

.filter-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-count {
  flex: 0 0 auto;
  color: var(--faint);
  font-size: 0.65625rem;
  font-variant-numeric: tabular-nums;
}

/* An active filter is a token with an ×, so one pick can be dropped without
   hunting for the menu that made it. */
.filter-tokens {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.filter-token {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  min-height: 26px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--ink);
  font-size: 0.75rem;
  font-weight: 600;
  text-decoration: none;
}

.filter-token i {
  font-style: normal;
  color: var(--faint);
  line-height: 1;
}

.filter-token:hover { border-color: var(--line-strong); }

.clear-filters {
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.clear-filters:hover { color: var(--ink); }

.calendar-link {
  display: inline-flex;
  align-items: center;
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.calendar-link:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.bar-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  color: var(--muted);
  text-decoration: none;
}

.bar-icon:hover {
  color: var(--ink);
  background: var(--surface);
}

.bar-icon svg {
  display: block;
  width: 18px;
  height: 18px;
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
  font-size: 0.78125rem;
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
  font-size: clamp(1.75rem, 5vw, 2.375rem);
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
  font-size: 0.75rem;
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
  font-size: 0.75rem;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.cal-weekday {
  padding: 4px 0;
  color: var(--faint);
  font-size: 0.625rem;
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
  font-size: 0.84375rem;
  font-variant-numeric: tabular-nums;
}

.cal-count {
  margin-top: 3px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 0.65625rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.cal-day.is-today { border-color: var(--accent); }
.cal-day.is-today .cal-num { font-weight: 800; }

.calendar-hint {
  margin: 14px 0 10px;
  color: var(--faint);
  font-size: 0.75rem;
}

.archive-chip {
  margin-left: 6px;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 0.65625rem;
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
  font-size: 0.5625rem;
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

.translate-banner strong { font-size: 0.8125rem; }

.translate-banner p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 0.75rem;
}

.translate-banner form { flex: 0 0 auto; }

.topic-language-note,
.version-language-note {
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 0.71875rem;
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
  font-size: 0.8125rem;
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
  font-size: 0.75rem;
  font-weight: 650;
}

.clear-search {
  color: var(--muted);
  font-size: 0.75rem;
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

/* The card's controls live beside the author, not under the content: one row
   of small pills — archive, remove, and the outbound link — with the source at
   the right edge where it has always been. */
.card-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-left: auto;
}

.card-tool {
  padding: 3px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font: inherit;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.45;
  white-space: nowrap;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}

.card-tool:hover { border-color: var(--ink); color: var(--ink); }
.card-tool.danger:hover { border-color: var(--red); background: var(--red-soft); color: var(--red); }

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
  font-size: 0.875rem;
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
  font-size: 0.5625rem;
}

.handle, .meta {
  color: var(--muted);
  font-size: 0.75rem;
}

.ref-chip {
  margin-left: 6px;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font: inherit;
  font-size: 0.6875rem;
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
  font-size: 0.75rem;
  text-decoration: none;
  white-space: nowrap;
}

.tweet-text {
  margin-bottom: 16px;
  font-size: 1.0625rem;
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

.card-poster {
  margin: 0 0 16px;
  min-width: 0;
  overflow: hidden;
  border-radius: 14px;
  background: var(--surface-soft);
}

.card-poster a { display: block; }

.card-poster img {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  max-height: 520px;
  object-fit: cover;
}

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

/* A YouTube card is a poster until the reader taps it; app.js replaces that
   link with the player, and both fill the same box, so the ratio holds. */
.yt-cell {
  position: relative;
  background: var(--deep);
  aspect-ratio: 16 / 9;
}

.yt-cell.is-portrait { aspect-ratio: 9 / 16; max-width: 360px; margin-inline: auto; }

.yt-cell .yt-card,
.yt-cell iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.yt-cell .yt-card img {
  display: block;
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: cover;
  opacity: 0.92;
}

.yt-cell .yt-card:hover img { opacity: 1; }

.yt-play {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 62px;
  height: 62px;
  margin: -31px 0 0 -31px;
  border: 1px solid var(--rule-strong);
  border-radius: 50%;
  background: var(--card);
  box-shadow: var(--shadow);
}

.yt-play::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  margin: -11px 0 0 -7px;
  border-style: solid;
  border-width: 11px 0 11px 18px;
  border-color: transparent transparent transparent var(--accent);
}

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
  font-size: 1.25rem;
  letter-spacing: -0.025em;
}

.linked-article p {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 0.8125rem;
  line-height: 1.55;
}

.article-open {
  color: var(--muted);
  font-size: 0.75rem;
  text-decoration: none;
}

.article-note {
  color: var(--faint);
  font-size: 0.6875rem;
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
  font-size: 0.5625rem;
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
  font-size: 0.8125rem;
  line-height: 1.35;
}

.link-description {
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.45;
}

.link-host {
  color: var(--faint);
  font-size: 0.625rem;
}

.link-arrow {
  margin-left: auto;
  color: var(--faint);
  font-size: 0.75rem;
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
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.quote-author {
  color: var(--muted);
  font-size: 0.75rem;
}

.quote-author span { color: var(--faint); }

.quote-text {
  font-size: 0.875rem;
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
  font-size: 0.875rem;
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
  font-size: 0.625rem;
  font-weight: 800;
  letter-spacing: 0.03em;
}

.summary-count {
  color: var(--faint);
  font-size: 0.6875rem;
  font-weight: 500;
}

.summary-time {
  margin-left: auto;
  color: var(--faint);
  font-size: 0.6875rem;
}

.summary-text {
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.summary-text a { color: var(--accent-ink); }

.transcripts {
  margin-top: 14px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.transcripts summary {
  color: var(--accent-ink);
  font-size: 0.78125rem;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

.transcripts summary::-webkit-details-marker { display: none; }

.transcript { margin-top: 12px; }

.transcript-meta {
  color: var(--faint);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.transcript-text {
  margin-top: 5px;
  max-height: 420px;
  overflow: auto;
  color: var(--muted);
  font-size: 0.84375rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.summary-note {
  margin: 0;
  color: var(--muted);
  font-size: 0.75rem;
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
  font-size: 1.875rem;
}

.empty h3 { margin-bottom: 6px; }
.empty p { color: var(--muted); }

.paging-note {
  margin: 18px 0 0;
  color: var(--faint);
  font-size: 0.75rem;
  text-align: center;
}

.footer {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding: 26px 0 44px;
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 0.6875rem;
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
  font-size: 2.125rem;
  letter-spacing: -0.045em;
}

.login-card .lede { margin-bottom: 22px; font-size: 0.875rem; }

.login-form { display: grid; gap: 8px; }

.login-form label {
  color: var(--muted);
  font-size: 0.75rem;
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
  font-size: 0.75rem;
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
  font-size: 0.875rem;
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
  font-size: 0.9375rem;
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
  font-size: 0.96875rem;
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
  font-size: 0.9375rem;
  line-height: 1.68;
}

.topic-overview p:last-child { margin-bottom: 0; }

.topic-overview-empty {
  color: var(--faint);
  font-size: 0.875rem;
}

.folder-crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 -6px;
  font-size: 0.8125rem;
}

.folder-crumbs a {
  color: var(--accent-ink);
  font-weight: 600;
  text-decoration: none;
}

.folder-crumbs a:hover { text-decoration: underline; }

.folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 12px;
  margin: 4px 0 22px;
}

.folder-card {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  min-width: 0;
  min-height: 104px;
  padding: 17px 17px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}

.folder-card:hover {
  border-color: var(--accent);
  box-shadow: 0 10px 26px rgba(31, 24, 18, 0.07);
  transform: translateY(-1px);
}

.folder-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--accent);
}

.folder-copy {
  display: grid;
  flex: 1 1 0;
  min-width: 0;
  gap: 5px;
}

.folder-name {
  overflow-wrap: anywhere;
  font-size: 0.96875rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.folder-desc {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 0.78125rem;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.folder-meta {
  color: var(--faint);
  font-size: 0.71875rem;
  font-variant-numeric: tabular-nums;
}

.folder-arrow {
  margin-left: auto;
  color: var(--faint);
  font-size: 0.9375rem;
}

.folder-hint {
  margin: 2px 0 18px;
  color: var(--muted);
  font-size: 0.84375rem;
  line-height: 1.5;
}

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
  font-size: 0.8125rem;
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
  font-size: 0.78125rem;
  list-style: none;
}

.version summary::-webkit-details-marker { display: none; }

.version-tag {
  color: var(--accent-ink);
  font-size: 0.6875rem;
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
  font-size: 0.875rem;
  line-height: 1.6;
}

.regen { margin-top: 12px; }

.regen summary {
  color: var(--accent-ink);
  font-size: 0.78125rem;
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
  font-size: 0.8125rem;
}

.regen button {
  padding: 8px 13px;
  border: none;
  border-radius: 10px;
  background: var(--ink);
  color: var(--bg);
  font: inherit;
  font-size: 0.78125rem;
  font-weight: 600;
  cursor: pointer;
}

.regen-note {
  margin: 6px 0 0;
  color: var(--faint);
  font-size: 0.71875rem;
}

.version-note {
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 0.78125rem;
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
.card.is-collapsed .card-poster,
.card.is-collapsed .quote,
.card.is-collapsed .link-stack,
.card.is-collapsed .linked-article,
.card.is-collapsed .versions,
.card.is-collapsed .regen { display: none; }

.peek-meta {
  display: none;
  margin: 10px 0 0;
  color: var(--faint);
  font-size: 0.75rem;
}

.card.is-collapsed .peek-meta { display: block; }

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
  font-size: 0.71875rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-decoration: none;
}

.card-topic:hover { background: var(--accent); color: var(--paper); }

/* Labels are the reader's own tags: a chip reads back as a filter, and the
   editor under it rewrites the whole set on that one card. Each chip carries
   the tone its slug hashes to, so a word keeps one colour everywhere. */
.card-labels {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 10px 0 2px;
}

.label {
  padding: 2px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 0.6875rem;
  font-weight: 600;
  text-decoration: none;
}

.label:hover {
  border-color: var(--line-strong);
  color: var(--ink);
}

${LABEL_TONE_CSS}

.label-editor { display: inline-block; }

.label-editor summary {
  padding: 2px 9px;
  border: 1px dashed var(--line-strong);
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.6875rem;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.label-editor summary::-webkit-details-marker { display: none; }
.label-editor[open] summary { border-style: solid; color: var(--ink); }
.label-editor[open] { display: block; flex-basis: 100%; width: 100%; }
.label-count { font-variant-numeric: tabular-nums; opacity: 0.65; }

.label-form {
  display: block;
  margin-top: 8px;
  max-width: 620px;
}

/* The ticks are the save, so each one reads as a chip in the row above the
   name: the card's chips keep their own styling, these are the choice. */
.label-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  max-height: 170px;
  overflow: auto;
}

.label-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
}

.label-check:hover { border-color: var(--line-strong); }
.label-check:has(input:checked) {
  border-color: var(--line-strong);
  background: var(--surface-soft);
  color: var(--ink);
}
.label-check input { width: 13px; height: 13px; margin: 0; accent-color: var(--accent); }

/* The new-name chip is one more item in that row: it opens into its own line
   only while a name is being typed, so no card carries a stray text field. */
.label-new { display: inline-flex; max-width: 100%; }
.label-new[open] { display: block; flex-basis: 100%; width: 100%; }

.label-new summary {
  padding: 4px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.6875rem;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.label-new summary::-webkit-details-marker { display: none; }
.label-new[open] summary { border-style: solid; color: var(--ink); }
.label-new-row { display: flex; gap: 6px; margin-top: 8px; }

.label-new-row input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--ink);
  font-size: 0.75rem;
  outline: 0;
}

.label-new-row input:focus { border-color: var(--line-strong); }

.label-form button {
  padding: 7px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: transparent;
  color: var(--ink);
  font-size: 0.75rem;
  font-weight: 650;
  white-space: nowrap;
}

.label-save { margin-top: 8px; }

/* Settings is a form, not a list, so it reads at the cloud's 920px measure.
   That is wider than the 820px reading column, so this page's own shell and
   topbar widen together and stay aligned with each other. */
body.settings-page .shell,
body.settings-page .topbar {
  width: min(920px, calc(100% - 36px));
}

.settings {
  max-width: 920px;
  margin-inline: auto;
  padding: 12px 0 60px;
}

.settings-head {
  padding-top: 24px;
  border-top: 1px solid var(--line);
}

.settings-head h2 {
  margin: 0 0 6px;
  font-size: 1.4375rem;
  letter-spacing: -0.03em;
}

.settings-lede {
  max-width: 620px;
  margin: 0;
  color: var(--muted);
  font-size: 0.875rem;
  line-height: 1.6;
}

/* One column of cards 11px apart, each card 16px in, is the cloud's rhythm. */
.settings-form {
  display: grid;
  gap: 11px;
  margin-top: 16px;
}

/* The appearance card posts on its own, so it sits outside the settings form;
   this keeps the 16px the form would have given it. */
.settings > #appearance {
  margin-top: 16px;
}

.settings-card {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.settings-card h3 {
  margin: 0;
  font-size: 0.9375rem;
  letter-spacing: -0.01em;
}

.settings-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.settings-badge {
  flex: 0 0 auto;
  max-width: 50%;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-badge.is-on,
.settings-badge.is-custom {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

/* A note sits 7px under whatever it explains and carries no bottom margin;
   each control declares its own top margin, so a card keeps one vertical
   rhythm whether the note comes above or below a field. */
.settings-note {
  max-width: 640px;
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.settings-note code {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-soft);
  color: var(--accent-ink);
  font-size: 0.6875rem;
}

.settings-card textarea {
  display: block;
  width: 100%;
  min-height: 260px;
  margin-top: 12px;
  padding: 13px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--bg);
  color: var(--ink);
  font: inherit;
  font-size: 0.84375rem;
  line-height: 1.6;
  resize: vertical;
  outline: 0;
}

.settings-card textarea:focus { border-color: var(--accent); }

.settings-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  color: var(--faint);
  font-size: 0.71875rem;
}

.settings-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

/* The page-level Save and Reset keep the one card action row's rhythm, one
   gap below the last card rather than tight against it. */
.settings-actions-foot {
  margin-top: 5px;
  padding: 0 2px;
}

.settings-actions button {
  padding: 10px 15px;
  border: 1px solid var(--ink);
  border-radius: 10px;
  background: var(--ink);
  color: var(--bg);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 650;
  cursor: pointer;
}

.settings-actions button.secondary {
  border-color: var(--line-strong);
  background: transparent;
  color: var(--ink);
}

.settings-actions button.secondary:hover {
  border-color: var(--accent);
  color: var(--accent-ink);
}

/* The language menu is a native select, so it carries its own search on every
   platform; the typed field below it is the escape hatch for a tag the list
   does not offer. Both keep the textarea's border and padding. */
.settings-card select,
.settings-field input {
  display: block;
  width: 100%;
  margin-top: 12px;
  padding: 11px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--bg);
  color: var(--ink);
  font: inherit;
  font-size: 0.84375rem;
  outline: 0;
}

.settings-card select:focus,
.settings-field input:focus { border-color: var(--accent); }

.settings-field {
  margin-top: 14px;
}

.settings-field .settings-label {
  display: block;
}

.settings-field input {
  margin-top: 7px;
}

/* Theme and text size are two short lists, so each reads as one row: a 96px
   label gutter and a segmented control, the same row the cloud uses. */
.settings-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}

.settings-label {
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 650;
}

.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-soft);
}

/* Each pill is a submit button, so the shadow sits on the button itself and
   the selected choice is the .is-on class rather than a checked radio. */
.segmented button {
  flex: 1 1 0;
  min-width: 0;
  padding: 6px 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.78125rem;
  font-weight: 650;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.segmented button:hover { color: var(--ink); }

.segmented button.is-on {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 2px rgba(15, 23, 32, 0.14);
}

.segmented button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* Provider, model and connection are three short facts, so they read as one
   row of boxed cells: dt is the small uppercase label, dd the value. Below the
   breakpoint the row becomes the one column it already is on a phone. */
.settings-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 12px 0 0;
}

.settings-facts div {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-soft);
}

.settings-facts dt {
  color: var(--faint);
  font-size: 0.65625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.settings-facts dd {
  margin: 3px 0 0;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.settings-card-muted { background: var(--surface-soft); }

.settings-toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--faint);
  font-size: 0.8125rem;
}

.settings-toggle input { accent-color: var(--accent); }

.settings-foot {
  margin: 18px 0 0;
  font-size: 0.8125rem;
}

.settings-foot a {
  color: var(--accent-ink);
  font-weight: 600;
  text-decoration: none;
}

.settings-foot a:hover { text-decoration: underline; }

/* The changelog card is a preview: three bullets, no headings, and a link to
   the page that has the rest. */
.settings-changelog {
  margin: 6px 0 0;
  padding-left: 18px;
}

.settings-changelog li {
  margin: 6px 0;
  font-size: 0.875rem;
  line-height: 1.55;
}

.settings-changelog code,
.release code {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-soft);
  font-family: var(--mono);
  font-size: 0.85em;
}

.settings-changelog-more {
  margin: 12px 0 0;
  font-size: 0.8125rem;
}

.settings-changelog-more a {
  color: var(--accent-ink);
  font-weight: 600;
  text-decoration: none;
}

.settings-changelog-more a:hover { text-decoration: underline; }

/* The changelog page is a document, not a card list: one column, a date per
   release and the changes under it. */
.changelog { max-width: 720px; }

.changelog h1 {
  margin: 4px 0 8px;
  font-size: clamp(1.625rem, 5.4vw, 2.125rem);
  line-height: 1.15;
  letter-spacing: -0.03em;
}

.changelog .lede {
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 0.9375rem;
  line-height: 1.6;
}

.release { margin: 26px 0 0; }

.release h2 {
  margin: 0 0 10px;
  font-size: 1.0625rem;
  letter-spacing: -0.02em;
}

.release time { color: var(--muted); }

.release ul {
  margin: 0;
  padding-left: 20px;
}

.release li {
  margin: 0 0 9px;
  line-height: 1.6;
}

@media (max-width: 650px) {
  .shell, .topbar { width: min(100% - 24px, 820px); }
  .topbar { padding-top: 18px; }
  .folder-grid { grid-template-columns: 1fr; gap: 10px; }
  .folder-card { min-height: 96px; padding: 15px; }
  .card.is-collapsed .tweet-text,
  .card.is-collapsed .summary-text { -webkit-line-clamp: 2; }
  .hero { padding: 54px 0 38px; }
  .hero h1 { font-size: clamp(2.375rem, 12vw, 3.625rem); }
  .lede { font-size: 0.9375rem; }
  .add-form { flex-direction: column; padding: 6px; }
  .add-form button { width: 100%; }
  .library-head { align-items: flex-start; flex-direction: column; }
  .library-tools { width: 100%; align-items: stretch; }
  .library-bar { align-items: stretch; position: relative; }
  .library-switches { justify-content: flex-start; }
  /* A phone cannot hang a 240px panel off a trigger near the edge, so an open
     menu becomes a sheet under the whole bar and the controls stay in place. */
  .filter-menu { position: static; }
  .filter-panel {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    width: auto;
    max-height: min(60vh, 20rem);
    margin-top: 6px;
  }
  .filter-tokens { justify-content: flex-start; }
  .translate-banner { align-items: flex-start; flex-direction: column; }
  .search-form { width: 100%; }
  .search-form input { flex: 1; width: auto; }
  .card { padding: 16px; border-radius: 18px; }
  .tweet-text { font-size: 1rem; }
  .card-head { flex-wrap: wrap; gap: 10px; }
  .card-tools { gap: 5px; }
  .media-grid.media-count-3 { grid-template-columns: repeat(2, 1fr); }
  .media-grid.media-count-3 .media-cell:first-child { grid-column: span 2; }
  .top-actions .count { display: none; }
  .login-card { padding: 25px; }
  .regen form { flex-direction: column; }
  .topic-brief { margin: 0 0 8px; }
  .topic-overview { padding: 15px 16px; }
  .topic-overview { padding: 16px 17px; }
  .topic-overview p { font-size: 0.9375rem; }
  .calendar-head { align-items: flex-start; flex-direction: column; gap: 10px; }
  .calendar-grid { gap: 4px; }
  .cal-day { min-height: 50px; border-radius: 9px; }
  .cal-weekday { font-size: 0.5625rem; }
  .cal-num { font-size: 0.78125rem; }
  .cal-count { padding: 0 5px; font-size: 0.59375rem; }
  .day-banner { align-items: flex-start; flex-direction: column; gap: 6px; }
  .settings-facts { grid-template-columns: 1fr; }
  .settings-row { grid-template-columns: 1fr; gap: 7px; }
  .settings-card textarea { min-height: 220px; }
  .settings-actions { flex-direction: column; align-items: stretch; }
  body.settings-page .shell,
  body.settings-page .topbar { width: min(100% - 24px, 920px); }
}

/* Motion is one pulse for a running summary plus colour and 1px lifts on
   hover. Readers who ask for less get none of it. */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
${NOTE_STYLES}
`;
