import { DurableObject } from 'cloudflare:workers';
import {
  bootstrapTopics,
  classifyPost,
  isAiConfigured,
  summarizePost,
  translateSummary,
  writeTopicOverview,
} from './ai.ts';
import { parseWebUrl, readExternalLinks, readWebPost } from './links.ts';
import { LABEL_LIMITS, parseLabelNames } from './labels.ts';
import { parseLinkedInUrl, readLinkedInPost } from './linkedin.ts';
import { NoteInputError, noteIdFor, notePlainText } from './notes.ts';
import {
  createVapidKeys,
  parsePushSubscription,
  pushEndpoint,
  sendPush,
  summaryNotification,
  type VapidKeys,
} from './push.ts';
import {
  defaultSummaryLanguage,
  normalizeSummariesEnabled,
  normalizeSummaryLanguage,
  normalizeSummaryPrompt,
  normalizeWorkspaceName,
} from './settings.ts';
import { parseYouTubeUrl, readYouTubePost } from './youtube.ts';
import { readTranscripts } from './transcript.ts';
import {
  clampInteger,
  filingReadySql,
  filterInSql,
  jsonResponse,
  parseSource,
  parseSourceList,
  recoverDisabledSummariesSql,
  searchQuerySql,
  sourceFilterSql,
  sourceFiltersSql,
  TOPIC_LIST_SQL,
  TOPIC_PROMPT_LIMIT,
} from './util.ts';
import { readPost } from './x.ts';
import type {
  ArchiveResult,
  ArchiveView,
  Bookmark,
  BookmarkRow,
  BootstrapItem,
  BootstrapTopic,
  CalendarResult,
  Env,
  LabelListResult,
  LabelName,
  LinkRead,
  ListResult,
  MediaItem,
  Metrics,
  NoteAgent,
  NoteInput,
  ParsedXUrl,
  PushNotification,
  PushSubscriptionRecord,
  Quote,
  ReindexResult,
  SaveResult,
  SourceFilter,
  StatsResult,
  StoreTranscriptsResult,
  StoredSettings,
  SummaryLanguage,
  SummaryVersion,
  TopicOverviewItem,
  TopicPageResult,
  TopicRow,
  TopicSummary,
  TranslateAllResult,
  VideoTranscript,
  XArticle,
} from './types.ts';

const STALE_SUMMARY_MS = 10 * 60 * 1000;

/* A gateway blip should cost seconds, not the card. One automatic retry after a
   minute covers a momentary 429/5xx; after that the reader decides. */
const SUMMARY_RETRY_DELAY_MS = 60 * 1000;
const MAX_SUMMARY_RETRIES = 1;

/* Short bookmark handles. The alphabet drops 0/o/1/l/i so a ref can be read
   aloud or typed without ambiguity. Refs always contain a letter: a digit-only
   ref would be indistinguishable from a tweet id (which is all digits). */
const REF_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const REF_LENGTH = 5;

function randomRef(): string {
  for (;;) {
    const bytes = new Uint8Array(REF_LENGTH);
    crypto.getRandomValues(bytes);
    let ref = '';
    for (const byte of bytes) ref += REF_ALPHABET[byte % REF_ALPHABET.length];
    if (/[a-z]/.test(ref)) return ref;
  }
}

function parseView(value: string | null | undefined): ArchiveView {
  return value === 'archived' || value === 'all' ? value : 'active';
}

/** `YYYY-MM-DD`, or null for anything that is not a real calendar day. */
function normalizeDay(value: string | null | undefined): string | null {
  const day = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === day ? day : null;
}

/** `YYYY-MM`, or null when the value is not a month. */
function normalizeMonth(value: string | null | undefined): string | null {
  const month = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}

function monthStart(month: string): string {
  return `${month}-01T00:00:00.000Z`;
}

function nextMonthStart(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString();
}

function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

function nextDayStart(day: string): string {
  const date = new Date(dayStart(day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

/* Take the context and SQL types from the base class: importing SqlStorage from
   @cloudflare/workers-types creates a second, structurally different copy and
   makes tsc compare two large recursive interfaces. */
type DoContext = ConstructorParameters<typeof DurableObject<Env>>[0];
type DoSql = DoContext['storage']['sql'];

/** A 404 from `resummarize`, carrying an HTTP status for the fetch handler. */
interface StatusError extends Error {
  status?: number;
}

type VersionRow = {
  tweet_id: string;
  version: number;
  instruction: string | null;
  summary: string;
  model: string | null;
  created_at: string;
};

/* Narrow row types for the column subsets each query selects. */
type ExistingBookmarkRow = {
  tweet_id: string;
  summary: string | null;
  summary_status: string;
  text: string;
  article_json: string;
};

type TopicCountRow = {
  slug: string;
  name: string;
  description: string;
  overview: string | null;
  overview_at: string | null;
  count: number;
  archived_count: number;
};

type TopicRefRow = { tweet_id: string; slug: string; name: string };

type NotificationRow = { id: number; title: string; body: string; url: string };

type PushRow = { endpoint: string; p256dh: string; auth: string };

type LabelRefRow = { tweet_id: string; slug: string; name: string };

type LabelCountRow = { slug: string; name: string; count: number };

type StatsRow = {
  total: number;
  archived: number | null;
  summarized: number | null;
  summarized_this_month: number | null;
  translated: number | null;
  pending: number | null;
};

type ArchiveCountsRow = {
  active: number | null;
  archived: number | null;
};

type AlarmCountsRow = { done: number; topics: number };

type PendingCountsRow = {
  summaries: number;
  filings: number;
  overviews: number;
  versions: number;
  translations: number;
};

type ReindexRow = {
  tweet_id: string;
  author_username: string | null;
  text: string | null;
  summary: string | null;
  saved_at: string | null;
};

type TopicItemRow = {
  author_username: string | null;
  text: string | null;
  summary: string | null;
  saved_at: string | null;
};

export class Bookmarks extends DurableObject<Env> {
  sql: DoSql;

  constructor(ctx: DoContext, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        tweet_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        author_name TEXT,
        author_username TEXT,
        author_avatar_url TEXT,
        author_verified INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        created_at TEXT,
        saved_at TEXT NOT NULL,
        provider TEXT,
        media_json TEXT NOT NULL DEFAULT '[]',
        quote_json TEXT NOT NULL DEFAULT 'null',
        article_json TEXT NOT NULL DEFAULT 'null',
        links_json TEXT NOT NULL DEFAULT '[]',
        transcripts_json TEXT NOT NULL DEFAULT '[]',
        metrics_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        summary_status TEXT NOT NULL DEFAULT 'pending',
        summary_error TEXT,
        summary_started_at INTEGER,
        summarized_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_bookmarks_saved_at
      ON bookmarks (saved_at DESC);

      CREATE TABLE IF NOT EXISTS topics (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        overview TEXT,
        overview_at TEXT,
        overview_count INTEGER NOT NULL DEFAULT -1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_topics (
        tweet_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        PRIMARY KEY (tweet_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_item_topics_slug
      ON item_topics (slug);

      CREATE TABLE IF NOT EXISTS summary_versions (
        tweet_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tweet_id, version)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL DEFAULT '',
        auth TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS labels (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookmark_labels (
        tweet_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        PRIMARY KEY (tweet_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_bookmark_labels_slug
      ON bookmark_labels (slug);
    `);

    try {
      this.sql.exec("ALTER TABLE bookmarks ADD COLUMN topics_status TEXT NOT NULL DEFAULT 'pending'");
    } catch {
      // Fresh databases already have the column.
    }

    try {
      this.sql.exec('ALTER TABLE bookmarks ADD COLUMN topics_at TEXT');
    } catch {
      // Fresh databases already have the column.
    }

    for (const statement of [
      "ALTER TABLE bookmarks ADD COLUMN version_status TEXT",
      "ALTER TABLE bookmarks ADD COLUMN version_instruction TEXT",
      'ALTER TABLE bookmarks ADD COLUMN version_started_at INTEGER',
      'ALTER TABLE bookmarks ADD COLUMN version_error TEXT',
    ]) {
      try {
        this.sql.exec(statement);
      } catch {
        // Fresh databases already have the column.
      }
    }

    try {
      this.sql.exec("ALTER TABLE bookmarks ADD COLUMN article_json TEXT NOT NULL DEFAULT 'null'");
    } catch {
      // Fresh databases already have the column.
    }

    try {
      this.sql.exec("ALTER TABLE bookmarks ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Fresh databases already have the column.
    }

    try {
      this.sql.exec("ALTER TABLE bookmarks ADD COLUMN transcripts_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Fresh databases already have the column.
    }

    try {
      this.sql.exec('ALTER TABLE bookmarks ADD COLUMN ref TEXT');
    } catch {
      // Fresh databases already have the column.
    }

    for (const statement of [
      'ALTER TABLE bookmarks ADD COLUMN archived_at TEXT',
      'ALTER TABLE bookmarks ADD COLUMN summary_en TEXT',
      'ALTER TABLE bookmarks ADD COLUMN summary_en_status TEXT',
      'ALTER TABLE bookmarks ADD COLUMN summary_en_error TEXT',
      'ALTER TABLE bookmarks ADD COLUMN summary_en_started_at INTEGER',
      'ALTER TABLE bookmarks ADD COLUMN summary_en_at TEXT',
      'ALTER TABLE bookmarks ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE bookmarks ADD COLUMN summary_retry_at INTEGER',
      "ALTER TABLE bookmarks ADD COLUMN kind TEXT NOT NULL DEFAULT 'post'",
      "ALTER TABLE bookmarks ADD COLUMN format TEXT NOT NULL DEFAULT 'text'",
      'ALTER TABLE bookmarks ADD COLUMN title TEXT',
      'ALTER TABLE bookmarks ADD COLUMN content TEXT',
      "ALTER TABLE bookmarks ADD COLUMN agent_json TEXT NOT NULL DEFAULT 'null'",
    ]) {
      try {
        this.sql.exec(statement);
      } catch {
        // Fresh databases already have the column.
      }
    }

    this.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_bookmarks_archived_at ON bookmarks (archived_at)',
    );

    // Give rows saved before refs existed a handle. Runs on wake, so it is a
    // no-op unless something is actually missing.
    const missingRefs = this.sql
      .exec<{ tweet_id: string }>('SELECT tweet_id FROM bookmarks WHERE ref IS NULL')
      .toArray();
    for (const row of missingRefs) {
      this.sql.exec('UPDATE bookmarks SET ref = ? WHERE tweet_id = ?', this.uniqueRef(), row.tweet_id);
    }

    try {
      this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_ref ON bookmarks (ref)');
    } catch {
      // Pre-existing duplicate refs would block the index; refs stay optional.
    }
  }

  /** Preferences stored in SQLite, with env fallbacks for older deployments. */
  settings(): StoredSettings {
    const rows = this.sql
      .exec<{ key: string; value: string }>('SELECT key, value FROM settings')
      .toArray();
    const values = new Map(rows.map(row => [row.key, row.value]));
    return {
      summaryPrompt: String(values.get('summary_prompt') || ''),
      summaryLanguage: normalizeSummaryLanguage(
        values.get('summary_language'),
        defaultSummaryLanguage(this.env),
      ),
      workspaceName: normalizeWorkspaceName(values.get('workspace_name')),
      summariesEnabled: normalizeSummariesEnabled(values.get('summaries_enabled'), true),
    };
  }

  saveSettings(input: {
    summaryPrompt?: unknown;
    summaryLanguage?: unknown;
    workspaceName?: unknown;
    summariesEnabled?: unknown;
  }): StoredSettings {
    const current = this.settings();
    const prompt =
      input.summaryPrompt === undefined
        ? current.summaryPrompt
        : normalizeSummaryPrompt(input.summaryPrompt);
    const language = normalizeSummaryLanguage(input.summaryLanguage, current.summaryLanguage);
    const workspaceName =
      input.workspaceName === undefined
        ? current.workspaceName
        : normalizeWorkspaceName(input.workspaceName);
    const summariesEnabled =
      input.summariesEnabled === undefined
        ? current.summariesEnabled
        : normalizeSummariesEnabled(input.summariesEnabled, current.summariesEnabled);
    this.putSetting('summary_prompt', prompt);
    this.putSetting('summary_language', language);
    this.putSetting('workspace_name', workspaceName);
    this.putSetting('summaries_enabled', summariesEnabled ? '1' : '0');

    return { summaryPrompt: prompt, summaryLanguage: language, workspaceName, summariesEnabled };
  }

  /** New saves are summarized only when a key exists and the reader left it on. */
  summariesOn(): boolean {
    return isAiConfigured(this.env) && this.settings().summariesEnabled;
  }

  /** The language for new summaries, and the page default when there is no `?lang=`. */
  primaryLanguage(): SummaryLanguage {
    return this.settings().summaryLanguage;
  }

  /** Empty means the built-in prompt in `src/ai.ts`. */
  summaryPrompt(): string {
    return this.settings().summaryPrompt;
  }

  /** The env object the AI helpers read `SUMMARY_LANGUAGE` from. */
  aiEnv(): Env {
    const language = this.primaryLanguage();
    const configured = String(this.env.SUMMARY_LANGUAGE || 'en').toLowerCase();
    return configured === language ? this.env : { ...this.env, SUMMARY_LANGUAGE: language };
  }

  private putSetting(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      new Date().toISOString(),
    );
  }

  /** The VAPID pair, generated on first use and kept out of StoredSettings. */
  async vapidKeys(): Promise<VapidKeys> {
    const rows = this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM settings WHERE key IN ('push_vapid_public', 'push_vapid_private')",
      )
      .toArray();
    const values = new Map(rows.map(row => [row.key, row.value]));
    const publicKey = values.get('push_vapid_public') || '';
    const privateJson = values.get('push_vapid_private') || '';
    if (publicKey && privateJson) {
      try {
        return { publicKey, privateKey: JSON.parse(privateJson) as JsonWebKey };
      } catch {
        console.warn('Stored VAPID key is unreadable; generating a new pair.');
      }
    }

    const keys = await createVapidKeys();
    this.putSetting('push_vapid_public', keys.publicKey);
    this.putSetting('push_vapid_private', JSON.stringify(keys.privateKey));
    return keys;
  }

  pushState(): { subscriptions: number } {
    const row = this.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM push_subscriptions')
      .toArray()[0];
    return { subscriptions: Number(row?.count ?? 0) };
  }

  subscribePush(record: PushSubscriptionRecord | null): { subscriptions: number } {
    if (!record) {
      const error: StatusError = new Error('That is not a valid HTTPS push subscription.');
      error.status = 400;
      throw error;
    }
    this.sql.exec(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
      record.endpoint,
      record.p256dh,
      record.auth,
      new Date().toISOString(),
    );
    // A person has a few browsers, not a fleet.
    this.sql.exec(
      `DELETE FROM push_subscriptions WHERE endpoint NOT IN (
         SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC, endpoint DESC LIMIT 10
       )`,
    );
    return this.pushState();
  }

  unsubscribePush(endpoint: string): { subscriptions: number } {
    if (endpoint) this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
    return this.pushState();
  }

  /** Hand the oldest undelivered row to one device, then mark it delivered. */
  nextNotification(): { notification: PushNotification | null } {
    const row = this.sql
      .exec<NotificationRow>(
        `SELECT id, title, body, url FROM notifications
         WHERE delivered_at IS NULL ORDER BY id ASC LIMIT 1`,
      )
      .toArray()[0];
    if (!row) return { notification: null };
    this.sql.exec(
      'UPDATE notifications SET delivered_at = ? WHERE id = ?',
      new Date().toISOString(),
      row.id,
    );
    return { notification: { title: row.title, body: row.body, url: row.url } };
  }

  queueNotification(notification: PushNotification): void {
    this.sql.exec(
      'INSERT INTO notifications (title, body, url, created_at) VALUES (?, ?, ?, ?)',
      notification.title,
      notification.body,
      notification.url,
      new Date().toISOString(),
    );
    this.sql.exec(
      `DELETE FROM notifications WHERE id NOT IN (
         SELECT id FROM notifications ORDER BY id DESC LIMIT 50
       )`,
    );
  }

  /** One payload-less push per browser; endpoints that return 404/410 go away. */
  async pushSubscriptions(): Promise<void> {
    const subscriptions = this.sql
      .exec<PushRow>('SELECT endpoint, p256dh, auth FROM push_subscriptions')
      .toArray();
    if (!subscriptions.length) return;

    const keys = await this.vapidKeys();
    const contact = String(this.env.PUSH_CONTACT || '').trim() || undefined;
    const results = await Promise.all(
      subscriptions.map(subscription => sendPush(subscription, keys, contact)),
    );
    results.forEach((result, index) => {
      if (result === 'gone') {
        this.sql.exec(
          'DELETE FROM push_subscriptions WHERE endpoint = ?',
          subscriptions[index].endpoint,
        );
      }
    });
  }

  async notifySummaryReady(bookmark: Bookmark): Promise<void> {
    try {
      this.queueNotification(summaryNotification(bookmark));
      await this.pushSubscriptions();
    } catch (error) {
      console.error('Summary notification failed', error);
    }
  }

  async testNotification(): Promise<{ queued: boolean; subscriptions: number }> {
    this.queueNotification({
      title: 'Shelf test notification',
      body: 'Notifications are working. A summary will arrive here next.',
      url: '/settings',
    });
    await this.pushSubscriptions();
    return { queued: true, subscriptions: this.pushState().subscriptions };
  }

  /** A ref that is not in use yet. */
  uniqueRef(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const ref = randomRef();
      const taken = this.sql.exec('SELECT 1 FROM bookmarks WHERE ref = ?', ref).toArray();
      if (!taken.length) return ref;
    }
    throw new Error('Could not allocate a bookmark ref.');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/save') {
        const body = (await request.json()) as { url: string | ParsedXUrl };
        return jsonResponse(await this.save(body.url));
      }

      if (request.method === 'GET' && url.pathname === '/settings') {
        return jsonResponse(this.settings());
      }

      if (request.method === 'POST' && url.pathname === '/settings') {
        const body = (await request.json()) as {
          summaryPrompt?: unknown;
          summaryLanguage?: unknown;
          workspaceName?: unknown;
          summariesEnabled?: unknown;
        };
        return jsonResponse(this.saveSettings(body));
      }

      if (request.method === 'GET' && url.pathname === '/push/key') {
        return jsonResponse({ publicKey: (await this.vapidKeys()).publicKey });
      }

      if (request.method === 'GET' && url.pathname === '/push/state') {
        return jsonResponse(this.pushState());
      }

      if (request.method === 'POST' && url.pathname === '/push/subscribe') {
        const body = (await request.json()) as {
          endpoint?: unknown;
          keys?: { p256dh?: unknown; auth?: unknown } | null;
        };
        return jsonResponse(this.subscribePush(parsePushSubscription(body)));
      }

      if (request.method === 'POST' && url.pathname === '/push/unsubscribe') {
        const body = (await request.json()) as { endpoint?: unknown };
        return jsonResponse(this.unsubscribePush(pushEndpoint(body.endpoint)?.toString() || ''));
      }

      if (request.method === 'GET' && url.pathname === '/notifications/next') {
        return jsonResponse(this.nextNotification());
      }

      if (request.method === 'POST' && url.pathname === '/notifications/test') {
        return jsonResponse(await this.testNotification());
      }

      if (request.method === 'POST' && url.pathname === '/notes') {
        return jsonResponse(await this.createNote((await request.json()) as NoteInput));
      }

      if (request.method === 'GET' && url.pathname === '/list') {
        return jsonResponse(this.list(url.searchParams));
      }

      if (request.method === 'GET' && url.pathname === '/calendar') {
        return jsonResponse(this.calendar(url.searchParams.get('month')));
      }

      if (request.method === 'GET' && url.pathname === '/topics') {
        return jsonResponse({ topics: this.topics() });
      }

      if (request.method === 'GET' && url.pathname === '/labels') {
        return jsonResponse(this.labels());
      }

      if (request.method === 'POST' && url.pathname === '/labels') {
        const body = (await request.json()) as { id?: string | null; labels?: unknown };
        const bookmark = this.setLabels(body.id ?? null, parseLabelNames(body.labels));
        if (!bookmark) return jsonResponse({ error: 'Bookmark not found.' }, 404);
        return jsonResponse({ bookmark });
      }

      if (request.method === 'POST' && url.pathname === '/labels/remove') {
        const body = (await request.json()) as { id?: string | null; slug?: unknown };
        const bookmark = this.removeLabel(body.id ?? null, String(body.slug ?? ''));
        if (!bookmark) return jsonResponse({ error: 'Label not found on that bookmark.' }, 404);
        return jsonResponse({ bookmark });
      }

      if (request.method === 'GET' && url.pathname === '/topic') {
        return jsonResponse(
          this.topic(
            url.searchParams.get('slug'),
            parseView(url.searchParams.get('view')),
            parseSource(url.searchParams.get('source')),
          ),
        );
      }

      if (request.method === 'POST' && url.pathname === '/archive') {
        const body = (await request.json()) as { id: string | null; archived?: boolean };
        return jsonResponse(this.archive(body.id, Boolean(body.archived)));
      }

      if (request.method === 'POST' && url.pathname === '/reindex') {
        return jsonResponse(await this.reindex());
      }

      if (request.method === 'GET' && url.pathname === '/get') {
        const bookmark = this.get(url.searchParams.get('id'));
        if (!bookmark) return jsonResponse({ error: 'Bookmark not found.' }, 404);
        return jsonResponse({ bookmark });
      }

      if (request.method === 'DELETE' && url.pathname === '/delete') {
        const body = (await request.json()) as { id: string | null };
        return jsonResponse({ deleted: this.delete(body.id) });
      }

      if (request.method === 'POST' && url.pathname === '/resummarize') {
        const body = (await request.json()) as {
          id: string | null;
          mode?: string;
          instruction?: string;
        };
        await this.resummarize(body.id, body);
        return jsonResponse({ queued: true });
      }

      if (request.method === 'POST' && url.pathname === '/transcripts') {
        const body = (await request.json()) as {
          id?: string | null;
          transcripts?: VideoTranscript[];
        };
        return jsonResponse(await this.storeTranscripts(body.id ?? null, body.transcripts ?? []));
      }

      if (request.method === 'POST' && url.pathname === '/translate-all') {
        return jsonResponse(await this.translateAll());
      }

      if (request.method === 'GET' && url.pathname === '/stats') {
        return jsonResponse(this.stats());
      }

      return jsonResponse({ error: 'Not found.' }, 404);
    } catch (error) {
      console.error('Durable Object error', error);
      const status = errorStatus(error);
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Unexpected error.' },
        status,
      );
    }
  }

  /** Create or refresh an agent note; no fetching, no AI summary job. */
  async createNote(input: NoteInput): Promise<SaveResult> {
    const refTarget = input.ref
      ? this.sql
          .exec<{ tweet_id: string; kind: string | null }>(
            'SELECT tweet_id, kind FROM bookmarks WHERE ref = ?',
            input.ref,
          )
          .toArray()[0]
      : undefined;
    if (input.ref && refTarget?.kind !== 'note') {
      throw new NoteInputError(`No note with ref #${input.ref}.`, 404);
    }
    const tweetId = refTarget ? refTarget.tweet_id : await noteIdFor(input.clientId);
    const now = new Date().toISOString();
    const text = notePlainText(input.format, input.content);
    const summary = input.summary;
    const summaryStatus = summary ? 'done' : 'disabled';
    const url = input.sourceUrl || '';
    const agentJson = JSON.stringify(input.agent ?? null);

    const existing = this.sql
      .exec<{ tweet_id: string }>('SELECT tweet_id FROM bookmarks WHERE tweet_id = ?', tweetId)
      .toArray()[0];

    if (existing) {
      this.sql.exec(
        `UPDATE bookmarks SET
          url = ?, text = ?, saved_at = ?, provider = 'note', kind = 'note',
          format = ?, title = ?, content = ?, agent_json = ?,
          summary = ?, summary_status = ?, summary_error = NULL, summarized_at = ?,
          summary_en = NULL, summary_en_status = NULL, summary_en_error = NULL,
          archived_at = NULL
        WHERE tweet_id = ?`,
        url,
        text,
        now,
        input.format,
        input.title,
        input.content,
        agentJson,
        summary,
        summaryStatus,
        summary ? now : null,
        tweetId,
      );
    } else {
      this.sql.exec(
        `INSERT INTO bookmarks (
          tweet_id, ref, url, text, saved_at, provider, kind, format, title, content,
          agent_json, summary, summary_status, summarized_at
        ) VALUES (?, ?, ?, ?, ?, 'note', 'note', ?, ?, ?, ?, ?, ?, ?)`,
        tweetId,
        this.uniqueRef(),
        url,
        text,
        now,
        input.format,
        input.title,
        input.content,
        agentJson,
        summary,
        summaryStatus,
        summary ? now : null,
      );
    }

    this.sql.exec(
      `UPDATE bookmarks SET topics_status = 'pending', topics_at = NULL WHERE tweet_id = ?`,
      tweetId,
    );
    // A re-posted note adds the labels it carried; it never drops the ones the
    // note already has, so an older client cannot untag it by omission.
    if (input.labels?.length) this.addLabels(tweetId, input.labels);
    await this.ctx.storage.setAlarm(Date.now() + 250);

    return { created: !existing, bookmark: this.get(tweetId) };
  }

  async save(input: string | ParsedXUrl): Promise<SaveResult> {
    const post =
      typeof input === 'string' && parseLinkedInUrl(input)
        ? await readLinkedInPost(input)
        : typeof input === 'string' && parseYouTubeUrl(input)
          ? await readYouTubePost(input, this.env)
          : typeof input === 'string' && parseWebUrl(input)
            ? await readWebPost(input, this.env)
            : await readPost(input, this.env);
    const existing: ExistingBookmarkRow | undefined = this.sql
      .exec<ExistingBookmarkRow>(
        `SELECT tweet_id, summary, summary_status, text, article_json
         FROM bookmarks WHERE tweet_id = ?`,
        post.tweetId,
      )
      .toArray()[0];

    const now = new Date().toISOString();
    const aiReady = this.summariesOn();
    const articleJson = JSON.stringify(post.article ?? null);
    const contentChanged = Boolean(
      existing &&
        (existing.text !== (post.text ?? '') || existing.article_json !== articleJson),
    );
    const alreadySummarized = Boolean(existing?.summary) && !contentChanged;
    const shouldSummarize = aiReady && !alreadySummarized;
    const summaryStatus = alreadySummarized
      ? existing?.summary_status || 'done'
      : shouldSummarize
        ? 'pending'
        : 'disabled';

    const values: (string | number | null)[] = [
      post.tweetId,
      post.url,
      post.author?.name ?? null,
      post.author?.username ?? null,
      post.author?.avatarUrl ?? null,
      post.author?.verified ? 1 : 0,
      post.text ?? '',
      post.createdAt ?? null,
      now,
      post.provider ?? null,
      JSON.stringify(post.media ?? []),
      JSON.stringify(post.quote ?? null),
      articleJson,
      JSON.stringify(post.metrics ?? {}),
      summaryStatus,
    ];

    if (existing) {
      const englishReset =
        shouldSummarize && this.primaryLanguage() === 'tr'
          ? `, summary_en = NULL, summary_en_status = 'pending',
             summary_en_error = NULL, summary_en_started_at = NULL`
          : '';
      // Re-sharing an archived post means the reader wants it back in the inbox.
      this.sql.exec(
        `UPDATE bookmarks SET
          url = ?, author_name = ?, author_username = ?, author_avatar_url = ?,
          author_verified = ?, text = ?, created_at = ?, saved_at = ?, provider = ?,
          media_json = ?, quote_json = ?, article_json = ?, metrics_json = ?,
          summary_status = ?, summary_error = NULL, summary_attempts = 0,
          summary_retry_at = NULL, archived_at = NULL${englishReset}
        WHERE tweet_id = ?`,
        ...values.slice(1),
        post.tweetId,
      );
    } else {
      const initialEnglishStatus =
        shouldSummarize && this.primaryLanguage() === 'tr' ? 'pending' : null;
      this.sql.exec(
        `INSERT INTO bookmarks (
          tweet_id, ref, url, author_name, author_username, author_avatar_url, author_verified,
          text, created_at, saved_at, provider, media_json, quote_json, article_json,
          metrics_json, summary_status, summary_en_status, summary_started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        values[0],
        this.uniqueRef(),
        ...values.slice(1),
        initialEnglishStatus,
      );
    }

    if (shouldSummarize) {
      this.sql.exec(
        `UPDATE bookmarks SET topics_status = 'pending', topics_at = NULL WHERE tweet_id = ?`,
        post.tweetId,
      );
      await this.ctx.storage.setAlarm(Date.now() + 250);
    }

    return {
      created: !existing,
      bookmark: this.get(post.tweetId),
    };
  }

  list(searchParams: URLSearchParams): ListResult {
    const query = (searchParams.get('q') || '').trim();
    const topics = searchParams
      .getAll('topic')
      .map(value => value.trim())
      .filter(Boolean);
    const labels = searchParams
      .getAll('label')
      .map(value => value.trim().slice(0, LABEL_LIMITS.slug))
      .filter(Boolean);
    const topicSlug = topics[0] || null;
    const labelKey = labels[0] || null;
    const day = normalizeDay(searchParams.get('day'));
    const view = parseView(searchParams.get('view'));
    const sources = parseSourceList(searchParams.getAll('source'));
    const limit = clampInteger(searchParams.get('limit'), 50, 1, 100);
    const offset = clampInteger(searchParams.get('offset'), 0, 0, 10_000);

    const filters: string[] = [];
    const args: string[] = [];

    const topicFilter = filterInSql('slug', topics);
    if (topicFilter) {
      filters.push(`tweet_id IN (SELECT tweet_id FROM item_topics WHERE ${topicFilter.sql})`);
      args.push(...topicFilter.args);
    }

    const labelFilter = filterInSql('slug', labels);
    if (labelFilter) {
      filters.push(`tweet_id IN (SELECT tweet_id FROM bookmark_labels WHERE ${labelFilter.sql})`);
      args.push(...labelFilter.args);
    }

    if (day) {
      filters.push('saved_at >= ? AND saved_at < ?');
      args.push(dayStart(day), nextDayStart(day));
    }

    // Source is resolved from the canonical URL, not from `provider`.
    const sourceFilter = sourceFiltersSql(sources);
    if (sourceFilter) filters.push(sourceFilter);

    // Every whitespace-separated term must match somewhere, so "claude code"
    // behaves like an AND search instead of a single literal substring.
    const querySql = searchQuerySql(query.split(/\s+/).filter(Boolean));
    if (querySql) {
      filters.push(querySql.sql);
      args.push(...querySql.args);
    }

    // Counts for the Active/Archived switch: same query, topic, and day, both sides.
    const baseWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const counts = this.sql
      .exec<ArchiveCountsRow>(
        `SELECT
           SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
         FROM bookmarks ${baseWhere}`,
        ...args,
      )
      .toArray()[0];

    // Count translations missing inside the current query/topic/day, so the
    // banner does not promise work for cards that are not on screen.
    const missingEnglish = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM bookmarks
         ${baseWhere ? `${baseWhere} AND` : 'WHERE'} summary_status = 'done'
           AND summary IS NOT NULL AND summary != ''
           AND (summary_en IS NULL OR summary_en = '')
           AND COALESCE(summary_en_status, '') NOT IN ('pending', 'working')`,
        ...args,
      )
      .toArray()[0];

    if (view === 'active') filters.push('archived_at IS NULL');
    if (view === 'archived') filters.push('archived_at IS NOT NULL');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = this.sql
      .exec<BookmarkRow>(
        `SELECT * FROM bookmarks ${where} ORDER BY saved_at DESC LIMIT ? OFFSET ?`,
        ...args,
        limit,
        offset,
      )
      .toArray();
    const countRow = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM bookmarks ${where}`, ...args)
      .toArray()[0];

    const bookmarks = rows.map(rowToBookmark);
    this.attachTopics(bookmarks);
    this.attachLabels(bookmarks);
    this.attachVersions(bookmarks);

    return {
      bookmarks,
      total: Number(countRow?.count ?? 0),
      query,
      topic: topicSlug || null,
      label: labelKey || null,
      day,
      view,
      activeTotal: Number(counts?.active ?? 0),
      archivedTotal: Number(counts?.archived ?? 0),
      missingEnglish: Number(missingEnglish?.count ?? 0),
      limit,
      offset,
    };
  }

  /** Save counts per day for one month. Counts include archived bookmarks. */
  calendar(monthParam: string | null): CalendarResult {
    const month = normalizeMonth(monthParam) || new Date().toISOString().slice(0, 7);
    const rows = this.sql
      .exec<{ saved_at: string }>(
        `SELECT saved_at FROM bookmarks
         WHERE saved_at >= ? AND saved_at < ?
         ORDER BY saved_at ASC`,
        monthStart(month),
        nextMonthStart(month),
      )
      .toArray();

    const counts = new Map<string, number>();
    for (const row of rows) {
      const date = String(row.saved_at || '').slice(0, 10);
      if (!date.startsWith(`${month}-`)) continue;
      counts.set(date, (counts.get(date) || 0) + 1);
    }

    const days = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, count]) => ({ date, count }));

    return {
      month,
      days,
      total: days.reduce((sum, day) => sum + day.count, 0),
    };
  }

  attachTopics(bookmarks: Bookmark[]): Bookmark[] {
    if (!bookmarks.length) return bookmarks;
    const ids = bookmarks.map(bookmark => bookmark.tweetId);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.sql
      .exec<TopicRefRow>(
        `SELECT it.tweet_id, it.slug, t.name
         FROM item_topics it
         JOIN topics t ON t.slug = it.slug
         WHERE it.tweet_id IN (${placeholders})
         ORDER BY t.name`,
        ...ids,
      )
      .toArray();

    const byTweet = new Map<string, Array<{ slug: string; name: string }>>();
    for (const row of rows) {
      const list = byTweet.get(row.tweet_id) ?? [];
      list.push({ slug: row.slug, name: row.name });
      byTweet.set(row.tweet_id, list);
    }
    for (const bookmark of bookmarks) {
      bookmark.topics = byTweet.get(bookmark.tweetId) ?? [];
    }
    return bookmarks;
  }

  /** The reader's tags for a page of cards, in one query rather than one each. */
  attachLabels(bookmarks: Bookmark[]): Bookmark[] {
    if (!bookmarks.length) return bookmarks;
    const ids = bookmarks.map(bookmark => bookmark.tweetId);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.sql
      .exec<LabelRefRow>(
        `SELECT bl.tweet_id, l.slug, l.name
         FROM bookmark_labels bl
         JOIN labels l ON l.slug = bl.slug
         WHERE bl.tweet_id IN (${placeholders})
         ORDER BY l.name COLLATE NOCASE`,
        ...ids,
      )
      .toArray();

    const byTweet = new Map<string, LabelName[]>();
    for (const row of rows) {
      const list = byTweet.get(row.tweet_id) ?? [];
      list.push({ slug: row.slug, name: row.name });
      byTweet.set(row.tweet_id, list);
    }
    for (const bookmark of bookmarks) {
      bookmark.labels = byTweet.get(bookmark.tweetId) ?? [];
    }
    return bookmarks;
  }

  /** The labels in use, most carried first: the library's filter row. */
  labels(): LabelListResult {
    const rows = this.sql
      .exec<LabelCountRow>(
        `SELECT l.slug, l.name, COUNT(bl.tweet_id) AS count
         FROM labels l
         JOIN bookmark_labels bl ON bl.slug = l.slug
         GROUP BY l.slug, l.name
         ORDER BY count DESC, l.name COLLATE NOCASE ASC
         LIMIT ?`,
        LABEL_LIMITS.menu,
      )
      .toArray();
    return {
      labels: rows.map(row => ({
        slug: row.slug,
        name: row.name,
        count: Number(row.count ?? 0),
      })),
    };
  }

  /** Replace one post's label set. Labels no post carries any more are dropped. */
  setLabels(idOrRef: string | null, labels: LabelName[]): Bookmark | null {
    const id = this.resolveId(idOrRef);
    if (!id) return null;
    const exists = this.sql
      .exec('SELECT 1 FROM bookmarks WHERE tweet_id = ?', id)
      .toArray();
    if (!exists.length) return null;
    this.writeLabels(id, labels);
    return this.get(id);
  }

  /** Drop one label from one post, leaving the rest of its set in place. */
  removeLabel(idOrRef: string | null, slug: string): Bookmark | null {
    const id = this.resolveId(idOrRef);
    if (!id) return null;
    const linked = this.sql
      .exec('SELECT 1 FROM bookmark_labels WHERE tweet_id = ? AND slug = ?', id, slug)
      .toArray();
    if (!linked.length) return null;
    this.sql.exec('DELETE FROM bookmark_labels WHERE tweet_id = ? AND slug = ?', id, slug);
    this.pruneLabels();
    return this.get(id);
  }

  private addLabels(tweetId: string, labels: LabelName[]): void {
    if (!labels.length) return;
    const current = this.sql
      .exec<{ name: string }>(
        `SELECT l.name FROM bookmark_labels bl
         JOIN labels l ON l.slug = bl.slug
         WHERE bl.tweet_id = ?`,
        tweetId,
      )
      .toArray();
    const merged = parseLabelNames([
      ...current.map(row => row.name),
      ...labels.map(label => label.name),
    ]);
    this.writeLabels(tweetId, merged);
  }

  /**
   * The whole set in one place. The first spelling of a slug wins, because a
   * label somebody typed as `Design` should not become `design` on the next
   * post that happens to use lowercase.
   */
  private writeLabels(tweetId: string, labels: LabelName[]): void {
    const now = new Date().toISOString();
    if (!labels.length) {
      this.sql.exec('DELETE FROM bookmark_labels WHERE tweet_id = ?', tweetId);
    } else {
      for (const label of labels) {
        this.sql.exec(
          `INSERT INTO labels (slug, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(slug) DO NOTHING`,
          label.slug,
          label.name,
          now,
        );
      }
      const placeholders = labels.map(() => '?').join(', ');
      this.sql.exec(
        `DELETE FROM bookmark_labels WHERE tweet_id = ? AND slug NOT IN (${placeholders})`,
        tweetId,
        ...labels.map(label => label.slug),
      );
      for (const label of labels) {
        this.sql.exec(
          'INSERT INTO bookmark_labels (tweet_id, slug) VALUES (?, ?) ON CONFLICT DO NOTHING',
          tweetId,
          label.slug,
        );
      }
    }
    this.pruneLabels();
  }

  /** A label on no post is a word nobody uses; keep the filter row honest. */
  private pruneLabels(): void {
    this.sql.exec('DELETE FROM labels WHERE slug NOT IN (SELECT slug FROM bookmark_labels)');
  }

  attachVersions(bookmarks: Bookmark[]): Bookmark[] {
    if (!bookmarks.length) return bookmarks;
    const ids = bookmarks.map(bookmark => bookmark.tweetId);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.sql
      .exec<VersionRow>(
        `SELECT tweet_id, version, instruction, summary, model, created_at
         FROM summary_versions
         WHERE tweet_id IN (${placeholders})
         ORDER BY version ASC`,
        ...ids,
      )
      .toArray();

    const byTweet = new Map<string, SummaryVersion[]>();
    for (const row of rows) {
      const list = byTweet.get(row.tweet_id) ?? [];
      list.push({
        version: Number(row.version),
        instruction: row.instruction || '',
        summary: row.summary,
        model: row.model,
        createdAt: row.created_at,
      });
      byTweet.set(row.tweet_id, list);
    }
    for (const bookmark of bookmarks) {
      bookmark.versions = byTweet.get(bookmark.tweetId) ?? [];
    }
    return bookmarks;
  }

  /**
   * Topics with their counts, busiest first. Unbounded for the views that need
   * every topic; `classifyRow` passes `TOPIC_PROMPT_LIMIT` so the filing prompt
   * carries the taxonomy in use rather than the whole archive.
   */
  topics(limit?: number) {
    const sql = limit === undefined ? TOPIC_LIST_SQL : `${TOPIC_LIST_SQL} LIMIT ?`;
    const args = limit === undefined ? [] : [limit];
    return this.sql
      .exec<TopicCountRow>(sql, ...args)
      .toArray()
      .map(row => ({
        slug: row.slug,
        name: row.name,
        description: row.description,
        overview: row.overview || '',
        overviewAt: row.overview_at,
        count: Number(row.count ?? 0),
        archivedCount: Number(row.archived_count ?? 0),
      }));
  }

  topic(slug: string | null, view: ArchiveView = 'active', source: SourceFilter = 'all'): TopicPageResult {
    const clean = String(slug || '').trim();
    const row = clean
      ? this.sql.exec<TopicRow>('SELECT * FROM topics WHERE slug = ?', clean).toArray()[0]
      : null;
    if (!row) return { topic: null, bookmarks: [], total: 0 };

    const archiveFilter =
      view === 'active'
        ? 'AND b.archived_at IS NULL'
        : view === 'archived'
          ? 'AND b.archived_at IS NOT NULL'
          : '';
    const sourceFilter = source === 'all' ? '' : `AND ${sourceFilterSql(source)}`;

    const bookmarks = this.sql
      .exec<BookmarkRow>(
        `SELECT b.* FROM bookmarks b
         JOIN item_topics it ON it.tweet_id = b.tweet_id
         WHERE it.slug = ? ${archiveFilter} ${sourceFilter}
         ORDER BY b.saved_at DESC
         LIMIT 100`,
        clean,
      )
      .toArray()
      .map(rowToBookmark);
    this.attachTopics(bookmarks);
    this.attachLabels(bookmarks);
    this.attachVersions(bookmarks);

    const counts = this.sql
      .exec<ArchiveCountsRow>(
        `SELECT
           SUM(CASE WHEN b.archived_at IS NULL THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN b.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
         FROM item_topics it
         JOIN bookmarks b ON b.tweet_id = it.tweet_id
         WHERE it.slug = ? ${sourceFilter}`,
        clean,
      )
      .toArray()[0];

    return {
      topic: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        overview: row.overview || '',
        overviewAt: row.overview_at,
        count: Number(counts?.active ?? 0),
        archivedCount: Number(counts?.archived ?? 0),
      },
      bookmarks,
      total: bookmarks.length,
    };
  }

  get(id: string | null | undefined): Bookmark | null {
    const tweetId = this.resolveId(id);
    if (!tweetId) return null;
    const row = this.sql
      .exec<BookmarkRow>('SELECT * FROM bookmarks WHERE tweet_id = ?', tweetId)
      .toArray()[0];
    if (!row) return null;
    const bookmark = rowToBookmark(row);
    this.attachTopics([bookmark]);
    this.attachLabels([bookmark]);
    bookmark.versions = this.versions(bookmark.tweetId);
    return bookmark;
  }

  /** Tweet ids are digits; a short ref or a stored key such as li<activityId> is anything else. */
  resolveId(idOrRef: string | null | undefined): string | null {
    if (!idOrRef) return null;
    const key = String(idOrRef).trim();
    if (!key) return null;
    if (/^\d{1,25}$/.test(key)) return key;
    const exact = this.sql
      .exec<{ tweet_id: string }>('SELECT tweet_id FROM bookmarks WHERE tweet_id = ?', key)
      .toArray()[0];
    if (exact?.tweet_id) return exact.tweet_id;
    const row = this.sql
      .exec<{ tweet_id: string }>('SELECT tweet_id FROM bookmarks WHERE lower(ref) = lower(?)', key)
      .toArray()[0];
    return row?.tweet_id ?? null;
  }

  versions(tweetId: string): SummaryVersion[] {
    return this.sql
      .exec<VersionRow>(
        `SELECT version, instruction, summary, model, created_at
         FROM summary_versions
         WHERE tweet_id = ?
         ORDER BY version ASC`,
        String(tweetId),
      )
      .toArray()
      .map(row => ({
        version: Number(row.version),
        instruction: row.instruction || '',
        summary: row.summary,
        model: row.model,
        createdAt: row.created_at,
      }));
  }

  delete(idOrRef: string | null): boolean {
    const id = this.resolveId(idOrRef);
    if (!id) return false;
    const before = this.sql.exec('SELECT tweet_id FROM bookmarks WHERE tweet_id = ?', id).toArray();
    if (!before.length) return false;

    const affected = this.sql
      .exec<{ slug: string }>('SELECT DISTINCT slug FROM item_topics WHERE tweet_id = ?', id)
      .toArray()
      .map(row => row.slug);

    this.sql.exec('DELETE FROM item_topics WHERE tweet_id = ?', id);
    this.sql.exec('DELETE FROM bookmark_labels WHERE tweet_id = ?', id);
    this.sql.exec('DELETE FROM summary_versions WHERE tweet_id = ?', id);
    this.sql.exec('DELETE FROM bookmarks WHERE tweet_id = ?', id);

    // The post's links are gone, so a label no other post carries is unused.
    this.pruneLabels();

    for (const slug of affected) {
      const remaining = this.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM item_topics WHERE slug = ?', slug)
        .toArray()[0];
      if (Number(remaining?.count ?? 0) === 0) {
        this.sql.exec('DELETE FROM topics WHERE slug = ?', slug);
      }
    }

    return true;
  }

  archive(idOrRef: string | null, archived: boolean): ArchiveResult {
    const id = this.resolveId(idOrRef);
    const bookmark = id ? this.get(id) : null;
    if (!bookmark) {
      const error: StatusError = new Error('Bookmark not found.');
      error.status = 404;
      throw error;
    }

    this.sql.exec(
      'UPDATE bookmarks SET archived_at = ? WHERE tweet_id = ?',
      archived ? new Date().toISOString() : null,
      id,
    );

    return { archived, bookmark: this.get(id) };
  }

  async translateAll(): Promise<TranslateAllResult> {
    if (!isAiConfigured(this.env)) {
      throw new Error('AI_API_KEY is not configured.');
    }
    if (this.primaryLanguage() !== 'tr') return { queued: 0 };

    const where = `summary_status = 'done' AND summary IS NOT NULL AND summary != ''
      AND (summary_en IS NULL OR summary_en = '')
      AND COALESCE(summary_en_status, '') NOT IN ('pending', 'working')`;

    const count = Number(
      this.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM bookmarks WHERE ${where}`)
        .toArray()[0]?.count ?? 0,
    );
    if (!count) return { queued: 0 };

    this.sql.exec(
      `UPDATE bookmarks
       SET summary_en_status = 'pending', summary_en_error = NULL, summary_en_started_at = NULL
       WHERE ${where}`,
    );
    await this.ctx.storage.setAlarm(Date.now() + 250);

    return { queued: count };
  }

  async resummarize(
    tweetId: string | null,
    options: { mode?: string; instruction?: string } = {},
  ): Promise<void> {
    if (!tweetId) throw new Error('Missing bookmark id.');
    const bookmark = this.get(tweetId);
    if (!bookmark) {
      const error: StatusError = new Error('Bookmark not found.');
      error.status = 404;
      throw error;
    }
    const id = bookmark.tweetId;
    if (!isAiConfigured(this.env)) {
      throw new Error('AI_API_KEY is not configured.');
    }

    if (options.mode === 'version') {
      this.sql.exec(
        `UPDATE bookmarks
         SET version_status = 'pending', version_instruction = ?, version_error = NULL,
             version_started_at = NULL
         WHERE tweet_id = ?`,
        String(options.instruction || '').slice(0, 500),
        id,
      );
    } else if (options.mode === 'translate') {
      if (!bookmark.summary || bookmark.summaryStatus !== 'done') {
        const error: StatusError = new Error('The primary summary is not ready yet.');
        error.status = 409;
        throw error;
      }
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_en_status = 'pending', summary_en_error = NULL, summary_en_started_at = NULL
         WHERE tweet_id = ?`,
        id,
      );
    } else {
      const englishReset = this.primaryLanguage() === 'tr'
        ? `, summary_en = NULL, summary_en_status = 'pending',
           summary_en_error = NULL, summary_en_started_at = NULL`
        : '';
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_status = 'pending', summary_error = NULL, summary_started_at = NULL,
             summary_attempts = 0, summary_retry_at = NULL,
             topics_status = 'pending', topics_at = NULL${englishReset}
         WHERE tweet_id = ?`,
        id,
      );
    }

    await this.ctx.storage.setAlarm(Date.now() + 250);
  }

  async storeTranscripts(
    idOrRef: string | null,
    incoming: VideoTranscript[],
  ): Promise<StoreTranscriptsResult> {
    const id = this.resolveId(idOrRef);
    if (!id) {
      const error: StatusError = new Error('Missing bookmark id.');
      error.status = 400;
      throw error;
    }

    const row = this.sql
      .exec<BookmarkRow>('SELECT * FROM bookmarks WHERE tweet_id = ?', id)
      .toArray()[0];
    if (!row) {
      const error: StatusError = new Error('Bookmark not found.');
      error.status = 404;
      throw error;
    }

    const clean = sanitizeTranscripts(incoming);
    if (!clean.length) {
      const error: StatusError = new Error('No usable transcripts were supplied.');
      error.status = 400;
      throw error;
    }

    const existing = parseJson<VideoTranscript[]>(row.transcripts_json, []);
    const merged = [
      ...existing.filter(transcript => !clean.some(next => next.url === transcript.url)),
      ...clean,
    ].slice(-4);

    this.sql.exec(
      'UPDATE bookmarks SET transcripts_json = ? WHERE tweet_id = ?',
      JSON.stringify(merged),
      id,
    );

    const queued = this.summariesOn() && clean.some(transcript => transcript.status === 'done');
    if (queued) {
      const englishReset = this.primaryLanguage() === 'tr'
        ? `, summary_en = NULL, summary_en_status = 'pending',
           summary_en_error = NULL, summary_en_started_at = NULL`
        : '';
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_status = 'pending', summary_error = NULL, summary_started_at = NULL,
             summary_attempts = 0, summary_retry_at = NULL,
             topics_status = 'pending', topics_at = NULL${englishReset}
         WHERE tweet_id = ?`,
        id,
      );
      await this.ctx.storage.setAlarm(Date.now() + 250);
    }

    return { stored: clean.length, queued };
  }

  stats(): StatsResult {
    const monthStart = (() => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    })();
    const row = this.sql
      .exec<StatsRow>(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
          SUM(CASE WHEN summary_status = 'done' THEN 1 ELSE 0 END) AS summarized,
          SUM(CASE WHEN summary_status = 'done' AND summarized_at >= ? THEN 1 ELSE 0 END)
            AS summarized_this_month,
          SUM(CASE WHEN summary_en_status = 'done' THEN 1 ELSE 0 END) AS translated,
          SUM(CASE WHEN summary_status IN ('pending', 'working') THEN 1 ELSE 0 END) AS pending
        FROM bookmarks`,
        monthStart,
      )
      .toArray()[0];

    let bytes = 0;
    try {
      bytes = Number(this.ctx.storage.sql.databaseSize ?? 0);
    } catch {
      bytes = 0;
    }

    const rows: Record<string, number> = {};
    for (const table of [
      'bookmarks',
      'summary_versions',
      'topics',
      'item_topics',
      'labels',
      'bookmark_labels',
    ]) {
      rows[table] = Number(
        this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]
          ?.count ?? 0,
      );
    }

    return {
      total: Number(row?.total ?? 0),
      archived: Number(row?.archived ?? 0),
      summarized: Number(row?.summarized ?? 0),
      summarizedThisMonth: Number(row?.summarized_this_month ?? 0),
      translated: Number(row?.translated ?? 0),
      pending: Number(row?.pending ?? 0),
      topics: rows.topics ?? 0,
      bytes,
      rows,
    };
  }

  async alarm(): Promise<void> {
    // A row saved while AI was off is parked at `disabled`, which no queue
    // query selects. Once AI is configured, move a bounded batch back to
    // `pending` so a recovered deployment picks the backlog up instead of
    // leaving it stuck. While AI stays off the helper returns null. The reader's
    // summaries switch gates this too, or a save made while it is off would be
    // summarized by the next pass.
    const aiConfigured = isAiConfigured(this.env);
    const recovery = recoverDisabledSummariesSql(this.summariesOn());
    if (recovery) this.sql.exec(recovery);

    const staleBefore = Date.now() - STALE_SUMMARY_MS;
    this.sql.exec(
      `UPDATE bookmarks
       SET summary_status = 'pending', summary_started_at = NULL, summary_retry_at = NULL
       WHERE summary_status = 'working' AND summary_started_at < ?`,
      staleBefore,
    );

    this.sql.exec(
      `UPDATE bookmarks
       SET version_status = 'pending', version_started_at = NULL
       WHERE version_status = 'working' AND version_started_at < ?`,
      staleBefore,
    );

    this.sql.exec(
      `UPDATE bookmarks
       SET summary_en_status = 'pending', summary_en_started_at = NULL
       WHERE summary_en_status = 'working' AND summary_en_started_at < ?`,
      staleBefore,
    );

    const pendingSummary = this.sql
      .exec<BookmarkRow>(
        `SELECT * FROM bookmarks
         WHERE summary_status = 'pending'
           AND (summary_retry_at IS NULL OR summary_retry_at <= ?)
         ORDER BY saved_at ASC
         LIMIT 1`,
        Date.now(),
      )
      .toArray()[0];

    if (pendingSummary) {
      await this.summarizeRow(pendingSummary);
      await this.scheduleNext();
      return;
    }

    const pendingVersion = this.sql
      .exec<BookmarkRow>(
        `SELECT * FROM bookmarks
         WHERE version_status = 'pending'
         ORDER BY saved_at ASC
         LIMIT 1`,
      )
      .toArray()[0];

    if (pendingVersion) {
      await this.generateVersion(pendingVersion);
      await this.scheduleNext();
      return;
    }

    // An English translation can only be written from a finished primary
    // summary. If the primary failed, clear the orphan so the queue can drain.
    this.sql.exec(
      `UPDATE bookmarks
       SET summary_en_status = 'failed',
           summary_en_error = 'The primary summary is not available, so there is nothing to translate.',
           summary_en_started_at = NULL
       WHERE summary_en_status = 'pending'
         AND (summary_status != 'done' OR summary IS NULL OR summary = '')`,
    );

    const pendingTranslation = this.sql
      .exec<BookmarkRow>(
        `SELECT * FROM bookmarks
         WHERE summary_en_status = 'pending'
         ORDER BY saved_at ASC
         LIMIT 1`,
      )
      .toArray()[0];

    if (pendingTranslation) {
      await this.translateRow(pendingTranslation);
      await this.scheduleNext();
      return;
    }

    const counts = this.sql
      .exec<AlarmCountsRow>(
        `SELECT
           (SELECT COUNT(*) FROM bookmarks WHERE summary_status = 'done') AS done,
           (SELECT COUNT(*) FROM topics) AS topics`,
      )
      .toArray()[0];
    const done = Number(counts?.done ?? 0);
    const topicCount = Number(counts?.topics ?? 0);

    if (topicCount === 0 && done >= 3) {
      const lastAttempt = Number((await this.ctx.storage.get<number>('topicBootstrapAt')) || 0);
      if (Date.now() - lastAttempt > 10 * 60 * 1000) {
        await this.ctx.storage.put('topicBootstrapAt', Date.now());
        try {
          await this.reindex();
        } catch (error) {
          console.error('Automatic topic bootstrap failed', error);
        }
      }
      await this.scheduleNext();
      return;
    }

    if (topicCount > 0) {
      const unfiled = this.sql
        .exec<BookmarkRow>(
          `SELECT * FROM bookmarks
           WHERE ${filingReadySql(aiConfigured)} AND topics_status = 'pending'
           ORDER BY saved_at ASC
           LIMIT 1`,
        )
        .toArray()[0];

      if (unfiled) {
        await this.classifyRow(unfiled);
        await this.scheduleNext();
        return;
      }

      const staleTopic = this.sql
        .exec<{ slug: string }>(
          `SELECT t.slug FROM topics t
           WHERE t.overview IS NULL OR t.overview_count != (
             SELECT COUNT(*) FROM item_topics it WHERE it.slug = t.slug
           )
           ORDER BY t.updated_at ASC
           LIMIT 1`,
        )
        .toArray()[0];

      if (staleTopic) {
        await this.refreshTopic(staleTopic.slug);
        await this.scheduleNext();
        return;
      }
    }
  }

  async scheduleNext(): Promise<void> {
    const now = Date.now();
    const hasTopics = Number(
      this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM topics').toArray()[0]?.count ?? 0,
    );
    const filingReady = filingReadySql(isAiConfigured(this.env));

    const pending = this.sql
      .exec<PendingCountsRow>(
        `SELECT
           (SELECT COUNT(*) FROM bookmarks
             WHERE summary_status = 'pending'
               AND (summary_retry_at IS NULL OR summary_retry_at <= ?)) AS summaries,
           (SELECT COUNT(*) FROM bookmarks
             WHERE ${filingReady} AND topics_status = 'pending') AS filings,
           (SELECT COUNT(*) FROM bookmarks WHERE version_status = 'pending') AS versions,
           (SELECT COUNT(*) FROM bookmarks WHERE summary_en_status = 'pending') AS translations,
           (SELECT COUNT(*) FROM topics t WHERE t.overview IS NULL OR t.overview_count != (
             SELECT COUNT(*) FROM item_topics it WHERE it.slug = t.slug
           )) AS overviews`,
        now,
      )
      .toArray()[0];

    const remaining =
      Number(pending?.summaries ?? 0) +
      Number(pending?.versions ?? 0) +
      Number(pending?.translations ?? 0) +
      (hasTopics ? Number(pending?.filings ?? 0) : 0) +
      Number(pending?.overviews ?? 0);

    if (remaining > 0) {
      await this.ctx.storage.setAlarm(now + 600);
      return;
    }

    // A summary waiting on its retry delay is the only work left: wake then,
    // instead of spinning the alarm every 600 ms until the delay passes.
    const nextRetry = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(summary_retry_at) AS at FROM bookmarks
         WHERE summary_status = 'pending' AND summary_retry_at > ?`,
        now,
      )
      .toArray()[0]?.at;

    if (nextRetry) {
      await this.ctx.storage.setAlarm(Number(nextRetry));
    }
  }

  async reindex(): Promise<ReindexResult> {
    if (!isAiConfigured(this.env)) {
      throw new Error('AI_API_KEY is not configured.');
    }

    const rows = this.sql
      .exec<ReindexRow>(
        `SELECT tweet_id, author_username, text, summary, saved_at
         FROM bookmarks
         WHERE summary_status = 'done' AND summary IS NOT NULL AND summary != ''
         ORDER BY saved_at ASC
         LIMIT 80`,
      )
      .toArray();

    if (!rows.length) return { topics: [], assigned: 0 };

    const items: BootstrapItem[] = rows.map(row => ({
      id: String(row.tweet_id),
      author: row.author_username,
      date: (row.saved_at || '').slice(0, 10),
      text: row.text,
      summary: row.summary,
    }));

    const built = await bootstrapTopics(items, this.aiEnv());
    if (!built.length) {
      throw new Error('AI could not group the archive into topics.');
    }

    const merged = new Map<string, BootstrapTopic>();
    for (const topic of built) {
      const current = merged.get(topic.slug);
      if (current) {
        current.itemIds.push(...topic.itemIds);
      } else {
        merged.set(topic.slug, { ...topic, itemIds: [...topic.itemIds] });
      }
    }

    const now = new Date().toISOString();
    this.sql.exec('DELETE FROM item_topics');
    this.sql.exec('DELETE FROM topics');

    let assigned = 0;
    for (const topic of merged.values()) {
      this.sql.exec(
        `INSERT INTO topics
           (slug, name, description, overview, overview_at, overview_count, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, -1, ?, ?)`,
        topic.slug,
        topic.name,
        topic.description,
        now,
        now,
      );
      for (const id of new Set(topic.itemIds)) {
        this.sql.exec(
          `INSERT OR IGNORE INTO item_topics (tweet_id, slug, confidence) VALUES (?, ?, 1)`,
          id,
          topic.slug,
        );
        assigned += 1;
      }
    }

    this.sql.exec(
      `UPDATE bookmarks SET topics_status = 'done', topics_at = ?
       WHERE tweet_id IN (SELECT tweet_id FROM item_topics)`,
      now,
    );

    await this.ctx.storage.setAlarm(Date.now() + 500);

    return { topics: this.topics(), assigned };
  }

  async classifyRow(row: BookmarkRow): Promise<void> {
    const tweetId = String(row.tweet_id);
    const bookmark = rowToBookmark(row);
    const topics = this.topics(TOPIC_PROMPT_LIMIT);

    try {
      const result = await classifyPost(
        { post: bookmark, summary: bookmark.summary || '', topics },
        this.aiEnv(),
      );

      if (!result.slugs.length) {
        throw new Error('AI did not pick a topic.');
      }

      const now = new Date().toISOString();

      if (result.created) {
        const exists = this.sql
          .exec<{ slug: string }>('SELECT slug FROM topics WHERE slug = ?', result.created.slug)
          .toArray()[0];
        if (!exists) {
          this.sql.exec(
            `INSERT INTO topics
               (slug, name, description, overview, overview_at, overview_count, created_at, updated_at)
             VALUES (?, ?, ?, NULL, NULL, -1, ?, ?)`,
            result.created.slug,
            result.created.name,
            result.created.description,
            now,
            now,
          );
        }
      }

      this.sql.exec('DELETE FROM item_topics WHERE tweet_id = ?', tweetId);
      for (const slug of result.slugs) {
        this.sql.exec(
          `INSERT OR IGNORE INTO item_topics (tweet_id, slug, confidence) VALUES (?, ?, ?)`,
          tweetId,
          slug,
          result.confidence,
        );
        this.sql.exec('UPDATE topics SET updated_at = ? WHERE slug = ?', now, slug);
      }
      this.sql.exec(
        `UPDATE bookmarks SET topics_status = 'done', topics_at = ? WHERE tweet_id = ?`,
        now,
        tweetId,
      );
    } catch (error) {
      console.error('Topic filing failed', tweetId, error);
      this.sql.exec(
        `UPDATE bookmarks SET topics_status = 'failed', topics_at = ? WHERE tweet_id = ?`,
        new Date().toISOString(),
        tweetId,
      );
    }
  }

  async generateVersion(row: BookmarkRow): Promise<void> {
    const tweetId = String(row.tweet_id);

    if (!isAiConfigured(this.env)) {
      this.sql.exec(
        `UPDATE bookmarks SET version_status = 'failed', version_error = 'AI is not configured.'
         WHERE tweet_id = ?`,
        tweetId,
      );
      return;
    }

    this.sql.exec(
      `UPDATE bookmarks SET version_status = 'working', version_started_at = ?
       WHERE tweet_id = ?`,
      Date.now(),
      tweetId,
    );

    try {
      const bookmark = rowToBookmark(row);
      const maxRow = this.sql
        .exec(
          'SELECT COALESCE(MAX(version), 1) AS max FROM summary_versions WHERE tweet_id = ?',
          tweetId,
        )
        .toArray()[0];
      const version = Number(maxRow?.max ?? 1) + 1;
      const instruction = String(row.version_instruction || '').slice(0, 500);

      const result = await summarizePost(bookmark, this.aiEnv(), {
        instruction,
        prompt: this.summaryPrompt(),
        previousSummary: bookmark.summary || '',
        session: `shelf-${tweetId}-v${version}`,
      });

      this.sql.exec(
        `INSERT INTO summary_versions (tweet_id, version, instruction, summary, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        tweetId,
        version,
        instruction,
        result.text,
        result.model,
        new Date().toISOString(),
      );
      this.sql.exec(
        `UPDATE bookmarks
         SET version_status = NULL, version_instruction = NULL, version_error = NULL,
             version_started_at = NULL
         WHERE tweet_id = ?`,
        tweetId,
      );
    } catch (error) {
      console.error('Version summary failed', tweetId, error);
      this.sql.exec(
        `UPDATE bookmarks
         SET version_status = 'failed', version_error = ?, version_started_at = NULL
         WHERE tweet_id = ?`,
        error instanceof Error ? error.message.slice(0, 500) : 'Unknown version error.',
        tweetId,
      );
    }
  }

  async refreshTopic(slug: string): Promise<void> {
    const row = this.sql
      .exec<TopicRow>('SELECT * FROM topics WHERE slug = ?', String(slug))
      .toArray()[0];
    if (!row) return;

    const countRow = this.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM item_topics WHERE slug = ?', row.slug)
      .toArray()[0];
    const count = Number(countRow?.count ?? 0);
    if (count === 0) return;

    const rows = this.sql
      .exec<TopicItemRow>(
        `SELECT b.author_username, b.text, b.summary, b.saved_at
         FROM bookmarks b
         JOIN item_topics it ON it.tweet_id = b.tweet_id
         WHERE it.slug = ? AND b.summary IS NOT NULL AND b.summary != ''
         ORDER BY b.saved_at DESC
         LIMIT 14`,
        row.slug,
      )
      .toArray()
      .reverse();

    if (!rows.length) {
      this.sql.exec(
        'UPDATE topics SET overview_count = ? WHERE slug = ?',
        count,
        row.slug,
      );
      return;
    }

    try {
      const items: TopicOverviewItem[] = rows.map(item => ({
        date: (item.saved_at || '').slice(0, 10),
        author: item.author_username,
        text: item.text,
        summary: item.summary,
      }));
      const overview = await writeTopicOverview(
        {
          topic: { slug: row.slug, name: row.name, description: row.description },
          previous: row.overview || '',
          items,
        },
        this.aiEnv(),
      );

      this.sql.exec(
        'UPDATE topics SET overview = ?, overview_at = ?, overview_count = ? WHERE slug = ?',
        overview,
        new Date().toISOString(),
        count,
        row.slug,
      );
    } catch (error) {
      console.error('Topic synthesis failed', row.slug, error);
      this.sql.exec(
        'UPDATE topics SET overview_count = ? WHERE slug = ?',
        count,
        row.slug,
      );
    }
  }

  async translateRow(row: BookmarkRow): Promise<void> {
    const tweetId = String(row.tweet_id);

    if (!isAiConfigured(this.env)) {
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_en_status = NULL, summary_en_error = NULL, summary_en_started_at = NULL
         WHERE tweet_id = ?`,
        tweetId,
      );
      return;
    }

    if (!row.summary || row.summary_status !== 'done') {
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_en_status = 'failed',
             summary_en_error = 'The primary summary is not available, so there is nothing to translate.',
             summary_en_started_at = NULL
         WHERE tweet_id = ?`,
        tweetId,
      );
      return;
    }

    this.sql.exec(
      `UPDATE bookmarks
       SET summary_en_status = 'working', summary_en_error = NULL, summary_en_started_at = ?
       WHERE tweet_id = ?`,
      Date.now(),
      tweetId,
    );

    try {
      const result = await translateSummary(row.summary, this.aiEnv(), {
        session: `shelf-${tweetId}-en`,
      });
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_en = ?, summary_en_status = 'done', summary_en_error = NULL,
             summary_en_started_at = NULL, summary_en_at = ?
         WHERE tweet_id = ?`,
        result.text,
        new Date().toISOString(),
        tweetId,
      );
    } catch (error) {
      console.error('English summary failed', tweetId, error);
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_en_status = 'failed', summary_en_error = ?, summary_en_started_at = NULL
         WHERE tweet_id = ?`,
        error instanceof Error ? error.message.slice(0, 500) : 'Unknown translation error.',
        tweetId,
      );
    }
  }

  async summarizeRow(row: BookmarkRow): Promise<void> {    const tweetId = String(row.tweet_id);

    if (!isAiConfigured(this.env)) {
      this.sql.exec(
        `UPDATE bookmarks
         SET summary_status = 'disabled', summary_error = NULL, summary_started_at = NULL,
             summary_en_status = NULL, summary_en_started_at = NULL
         WHERE tweet_id = ?`,
        tweetId,
      );
      return;
    }

    this.sql.exec(
      `UPDATE bookmarks
       SET summary_status = 'working', summary_error = NULL, summary_started_at = ?,
           summary_retry_at = NULL
       WHERE tweet_id = ?`,
      Date.now(),
      tweetId,
    );

    try {
      const bookmark = rowToBookmark(row);

      try {
        bookmark.links = await readExternalLinks(bookmark, this.env);
        this.sql.exec(
          'UPDATE bookmarks SET links_json = ? WHERE tweet_id = ?',
          JSON.stringify(bookmark.links),
          tweetId,
        );
      } catch (error) {
        console.error('Link reading failed', tweetId, error);
      }

      if (!bookmark.transcripts.length) {
        try {
          bookmark.transcripts = await readTranscripts(bookmark, this.env);
          this.sql.exec(
            'UPDATE bookmarks SET transcripts_json = ? WHERE tweet_id = ?',
            JSON.stringify(bookmark.transcripts),
            tweetId,
          );
        } catch (error) {
          console.error('Transcript reading failed', tweetId, error);
        }
      }

      const result = await summarizePost(bookmark, this.aiEnv(), {
        prompt: this.summaryPrompt(),
      });
      const english =
        this.primaryLanguage() === 'tr'
          ? `, summary_en = NULL, summary_en_status = 'pending',
             summary_en_error = NULL, summary_en_started_at = NULL`
          : '';
      this.sql.exec(
        `UPDATE bookmarks
         SET summary = ?, summary_status = 'done', summary_error = NULL,
             summary_started_at = NULL, summary_attempts = 0, summary_retry_at = NULL,
             summarized_at = ?, topics_status = 'pending', topics_at = NULL${english}
         WHERE tweet_id = ?`,
        result.text,
        new Date().toISOString(),
        tweetId,
      );
      await this.notifySummaryReady({ ...bookmark, summary: result.text });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : 'Unknown summary error.';
      const attempts = Number(row.summary_attempts ?? 0);

      if (attempts < MAX_SUMMARY_RETRIES) {
        console.warn('Summary failed; retrying in a minute', tweetId, error);
        this.sql.exec(
          `UPDATE bookmarks
           SET summary_status = 'pending', summary_attempts = ?, summary_retry_at = ?,
               summary_error = ?, summary_started_at = NULL
           WHERE tweet_id = ?`,
          attempts + 1,
          Date.now() + SUMMARY_RETRY_DELAY_MS,
          message,
          tweetId,
        );
      } else {
        console.error('Summary failed', tweetId, error);
        this.sql.exec(
          `UPDATE bookmarks
           SET summary_status = 'failed', summary_attempts = ?, summary_retry_at = NULL,
               summary_error = ?, summary_started_at = NULL
           WHERE tweet_id = ?`,
          attempts + 1,
          message,
          tweetId,
        );
      }
    }
  }
}

function sanitizeTranscripts(input: VideoTranscript[]): VideoTranscript[] {
  if (!Array.isArray(input)) return [];

  return input
    .slice(0, 4)
    .map((value): VideoTranscript | null => {
      if (!value || typeof value !== 'object') return null;
      const record = value as unknown as Record<string, unknown>;
      const url = String(record.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return null;

      const text = String(record.text || '').slice(0, 120_000);
      const status =
        record.status === 'done' || record.status === 'unavailable' || record.status === 'failed'
          ? record.status
          : 'failed';
      const source = record.source === 'youtube' ? 'youtube' : 'x';
      const provider =
        record.provider === 'supadata' ||
        record.provider === 'workers-ai' ||
        record.provider === 'local'
          ? record.provider
          : null;
      const durationSec = Number(record.durationSec);
      const bytes = Number(record.bytes);

      return {
        url: url.slice(0, 2000),
        source,
        provider,
        lang: record.lang ? String(record.lang).slice(0, 20) : null,
        text,
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
        bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
        status,
        error: record.error ? String(record.error).slice(0, 500) : null,
        at: record.at ? String(record.at) : new Date().toISOString(),
      };
    })
    .filter((transcript): transcript is VideoTranscript => Boolean(transcript));
}

function rowToBookmark(row: BookmarkRow): Bookmark {
  return {
    ref: row.ref || '',
    tweetId: row.tweet_id,
    url: row.url,
    text: row.text,
    kind: row.kind === 'note' ? 'note' : 'post',
    format: row.format === 'markdown' || row.format === 'html' ? row.format : 'text',
    title: row.title ?? null,
    content: row.content ?? null,
    agent: parseJson<NoteAgent | null>(row.agent_json ?? 'null', null),
    sourceUrl: row.url || null,
    createdAt: row.created_at,
    savedAt: row.saved_at,
    provider: row.provider,
    author: {
      name: row.author_name,
      username: row.author_username,
      avatarUrl: row.author_avatar_url,
      verified: Boolean(row.author_verified),
    },
    media: parseJson<MediaItem[]>(row.media_json, []),
    quote: parseJson<Quote | null>(row.quote_json, null),
    article: parseJson<XArticle | null>(row.article_json, null),
    links: parseJson<LinkRead[]>(row.links_json, []),
    transcripts: parseJson<VideoTranscript[]>(row.transcripts_json, []),
    // Filled by attachLabels for a page of cards; a bare row has no tag yet.
    labels: [],
    // `{}` is the historical fallback for a missing metrics column; the API and
    // the stored row keep the counts even though a card no longer draws them.
    metrics: parseJson<Metrics>(row.metrics_json, {} as Metrics),
    summary: row.summary,
    summaryStatus: row.summary_status,
    summaryError: row.summary_error,
    summarizedAt: row.summarized_at,
    summaryEn: row.summary_en ?? null,
    summaryEnStatus: row.summary_en_status ?? null,
    summaryEnError: row.summary_en_error ?? null,
    summaryEnAt: row.summary_en_at ?? null,
    archivedAt: row.archived_at ?? null,
    versionStatus: row.version_status,
    versionError: row.version_error,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function errorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return 500;
}
