#!/usr/bin/env bun
/**
 * xbv — read the X Bookmark Vault from a terminal or an AI client.
 *
 * The vault lives in a Cloudflare Worker (`https://bookmark.nuritas.tr`). This
 * CLI talks to its JSON API with the same `APP_PASSWORD` the web login uses, so
 * nothing has to be synced: the Worker stays the single source of truth.
 *
 * Two ways to use it with AI:
 *   1. `xbv search ...` / `xbv show k7f3 ...` — pipe markdown into any chat.
 *   2. `xbv mcp` — a stdio MCP server so Claude Code/Desktop, Codex, Cursor
 *      etc. can search the archive themselves via tools.
 *
 * Run with bun (no dependencies, no build step):
 *   xbv search "claude code"
 *   xbv show 1985100000000000000
 *   xbv export --dir ~/Documents/bookmarks
 *   xbv mcp
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Bookmark,
  GetResult,
  ListResult,
  SummaryVersion,
  TopicListResult,
} from '../src/types.ts';

const VERSION = '0.1.0';
const DEFAULT_URL = 'https://bookmark.nuritas.tr';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Config {
  url: string;
  password: string;
  /** Where the password came from, for `xbv config`. */
  source: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags };
}

function configPath(): string {
  return process.env.XBV_CONFIG || join(homedir(), '.config', 'xbv', 'config.json');
}

function readConfigFile(): Partial<Config> | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    return { url: parsed.url, password: parsed.password, source: path };
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}

function parseDevVars(path: string): string | null {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*APP_PASSWORD\s*=\s*(.+)\s*$/);
      if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // unreadable file is the same as a missing one
  }
  return null;
}

/** Walk up from these directories looking for the repo's `.dev.vars`. */
function findDevVars(startDirs: string[]): string | null {
  for (const start of startDirs) {
    let dir = start;
    for (let depth = 0; depth < 6; depth++) {
      const candidate = join(dir, '.dev.vars');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function loadConfig(): Config {
  const url = (process.env.XBV_URL || '').trim().replace(/\/+$/, '');
  const password = process.env.XBV_PASSWORD || '';

  if (url && password) {
    return { url, password, source: 'environment' };
  }

  const file = readConfigFile();
  if (file?.url && file.password) {
    return { url: file.url.replace(/\/+$/, ''), password: file.password, source: file.source || configPath() };
  }

  const here = process.cwd();
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const devVars = findDevVars([here, scriptDir]);
  if (devVars) {
    const devPassword = parseDevVars(devVars);
    if (devPassword) {
      return {
        url: url || file?.url || DEFAULT_URL,
        password: devPassword,
        source: devVars,
      };
    }
  }

  throw new Error(
    [
      'No vault password found.',
      '',
      'Set one of:',
      '  XBV_PASSWORD (and optionally XBV_URL)',
      `  ${configPath()}  →  { "url": "${DEFAULT_URL}", "password": "..." }`,
      'or run from a checkout that contains .dev.vars.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const config = loadConfig();
  const url = new URL(path, `${config.url}/`);

  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.password}`,
      Accept: 'application/json',
    },
  });

  const body = await response.text();

  if (!response.ok) {
    let detail = body.trim();
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      // plain-text error body
    }
    if (response.status === 401) {
      throw new Error(
        `401 Unauthorized — the password in ${config.source} is not the one the Worker uses.\n` +
          'Update it with `xbv config --password <new>` or fix .dev.vars/XBV_PASSWORD.',
      );
    }
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }

  return (body ? JSON.parse(body) : null) as T;
}

/** Page through `/api/bookmarks` until every match is fetched. */
async function fetchAllBookmarks(params: Record<string, string | number>): Promise<Bookmark[]> {
  const collected: Bookmark[] = [];
  let offset = 0;

  for (;;) {
    const page = await api<ListResult>('api/bookmarks', { ...params, limit: 100, offset });
    collected.push(...page.bookmarks);
    offset += page.bookmarks.length;
    if (!page.bookmarks.length || offset >= page.total) break;
  }

  return collected;
}

/** Accepts a short ref ("k7f3"), a tweet id, or an x.com status URL. */
function bookmarkIdArg(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9]{1,25}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/\/status(?:es)?\/(\d{1,25})/);
  if (match) return match[1];
  const idQuery = trimmed.match(/[?&]id=(\d{1,25})/);
  if (idQuery) return idQuery[1];
  throw new Error(`Not a bookmark id, tweet id, or URL: ${value}`);
}

// ---------------------------------------------------------------------------
// Markdown rendering — tuned for pasting into an LLM, not for the browser
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function isoDay(value: string | null | undefined): string {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function authorLabel(bookmark: Bookmark): string {
  const username = bookmark.author?.username;
  if (username) return `@${username}`;
  return bookmark.author?.name || 'unknown author';
}

function topicNames(bookmark: Bookmark): string {
  return (bookmark.topics || []).map(topic => topic.name).join(', ');
}

function renderCard(bookmark: Bookmark, index: number): string {
  const flags = bookmark.archivedAt ? ' · archived' : '';
  const lines = [`${index}. ${authorLabel(bookmark)} · ${isoDay(bookmark.savedAt)}${flags} · ${bookmark.url}`];
  const topics = topicNames(bookmark);
  if (topics) lines.push(`   topics: ${topics}`);
  const summary = (bookmark.summary || bookmark.text || '').replace(/\s+/g, ' ').trim();
  if (summary) lines.push(`   ${truncate(summary, 240)}`);
  lines.push(`   id: ${bookmark.ref || bookmark.tweetId}`);
  return lines.join('\n');
}

function renderLink(link: Bookmark['links'][number]): string {
  const heading = link.title || link.siteName || link.url;
  const lines = [`### ${heading}`, link.finalUrl || link.url];
  if (link.siteName) lines.push(`_${link.siteName}_`);
  if (link.description) lines.push('', truncate(link.description, 400));
  if (link.text) lines.push('', truncate(link.text, 2000));
  return lines.join('\n');
}

function renderVersions(versions: SummaryVersion[]): string {
  if (!versions.length) return '';
  const blocks = versions.map(version => {
    const label = version.instruction ? ` — “${version.instruction}”` : '';
    return `## Summary v${version.version}${label}\n\n${version.summary.trim()}`;
  });
  return blocks.join('\n\n');
}

function renderBookmark(bookmark: Bookmark): string {
  const lines: string[] = [];

  lines.push(`# ${authorLabel(bookmark)} — ${isoDay(bookmark.createdAt || bookmark.savedAt)}`);
  lines.push('');
  lines.push(bookmark.url);

  const meta = [`Saved ${isoDay(bookmark.savedAt)}`];
  const topics = topicNames(bookmark);
  if (topics) meta.push(`Topics: ${topics}`);
  if (bookmark.archivedAt) meta.push('Archived');
  if (bookmark.ref) meta.push(`id: ${bookmark.ref}`);
  meta.push(`tweet: ${bookmark.tweetId}`);
  lines.push('', meta.join(' · '));

  if (bookmark.summary) {
    const heading = bookmark.summaryEn ? '## AI summary (Turkish)' : '## AI summary';
    lines.push('', heading, '', bookmark.summary.trim());
  } else if (bookmark.summaryStatus === 'pending') {
    lines.push('', '## AI summary', '', `_Still pending (status: ${bookmark.summaryStatus})._`);
  }

  if (bookmark.summaryEn) {
    lines.push('', '## AI summary (English)', '', bookmark.summaryEn.trim());
  }

  lines.push('', '## Original post', '', bookmark.text?.trim() || '_No text captured._');

  if (bookmark.article?.text) {
    lines.push('', `## X Article — ${bookmark.article.title || 'untitled'}`, '');
    lines.push(truncate(bookmark.article.text, 6000));
  }

  if (bookmark.quote?.text) {
    const quoteAuthor = bookmark.quote.author?.username
      ? `@${bookmark.quote.author.username}`
      : 'quoted post';
    lines.push('', `## Quoted post — ${quoteAuthor}`, '', bookmark.quote.text.trim());
  }

  for (const link of bookmark.links || []) {
    if (!link.title && !link.text) continue;
    lines.push('', renderLink(link));
  }

  const versions = renderVersions(bookmark.versions || []);
  if (versions) lines.push('', versions);

  for (const transcript of bookmark.transcripts || []) {
    if (transcript.status !== 'done' || !transcript.text.trim()) continue;
    const source = transcript.source === 'youtube' ? 'YouTube' : 'X video';
    lines.push(
      '',
      `## Video transcript — ${source} (${transcript.lang || 'unknown language'})`,
      '',
      truncate(transcript.text.trim(), 6000),
    );
  }

  if (bookmark.media?.length) {
    lines.push('', `_Media: ${bookmark.media.length} item(s)._`);
  }

  return lines.join('\n');
}

function renderTopics(data: TopicListResult): string {
  if (!data.topics.length) return 'No topics yet — save a few more bookmarks.';
  return data.topics
    .map(topic => {
      const counts = `${topic.count} active${topic.archivedCount ? `, ${topic.archivedCount} archived` : ''}`;
      const header = `## ${topic.name} (${topic.slug}) — ${counts}`;
      const parts = [header];
      if (topic.description) parts.push('', topic.description);
      if (topic.overview) parts.push('', topic.overview.trim());
      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function clampLimit(value: string | boolean | undefined, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

async function commandSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ').trim();
  if (!query) throw new Error('Usage: xbv search <words> [--limit 10] [--json]');

  const limit = clampLimit(args.flags.limit, 10, 50);
  const result = await api<ListResult>('api/bookmarks', { q: query, limit, view: 'all' });

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.bookmarks.length) {
    console.log(`No bookmarks matched “${query}”.`);
    return;
  }

  console.log(`${result.total} match${result.total === 1 ? '' : 'es'} for “${query}”\n`);
  result.bookmarks.forEach((bookmark, index) => {
    console.log(renderCard(bookmark, index + 1));
    console.log('');
  });
}

async function commandRecent(args: ParsedArgs): Promise<void> {
  const limit = clampLimit(args.flags.limit, 10, 50);
  const result = await api<ListResult>('api/bookmarks', { limit });

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${result.total} saved bookmarks — newest first\n`);
  result.bookmarks.forEach((bookmark, index) => {
    console.log(renderCard(bookmark, index + 1));
    console.log('');
  });
}

async function commandShow(args: ParsedArgs): Promise<void> {
  const target = args.positional[0];
  if (!target) throw new Error('Usage: xbv show <id | tweet id | x.com URL> [--json]');

  const id = bookmarkIdArg(target);
  const result = await api<GetResult>(`api/bookmarks/${id}`);

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderBookmark(result.bookmark));
}

async function commandTopics(args: ParsedArgs): Promise<void> {
  const data = await api<TopicListResult>('api/topics');
  if (args.flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(renderTopics(data));
}

async function commandTopic(args: ParsedArgs): Promise<void> {
  const slug = args.positional[0];
  if (!slug) throw new Error('Usage: xbv topic <slug> [--limit 50] [--json]');

  const limit = clampLimit(args.flags.limit, 50, 100);
  const topics = await api<TopicListResult>('api/topics');
  const topic = topics.topics.find(item => item.slug === slug || item.name.toLowerCase() === slug.toLowerCase());
  if (!topic) {
    const known = topics.topics.map(item => item.slug).join(', ') || '(none)';
    throw new Error(`Unknown topic “${slug}”. Known: ${known}`);
  }

  const result = await api<ListResult>('api/bookmarks', { topic: topic.slug, limit, view: 'all' });

  if (args.flags.json) {
    console.log(JSON.stringify({ topic, bookmarks: result.bookmarks, total: result.total }, null, 2));
    return;
  }

  const counts = `${topic.count} active${topic.archivedCount ? `, ${topic.archivedCount} archived` : ''}`;
  const parts = [`# ${topic.name} — ${counts}`];
  if (topic.description) parts.push('', topic.description);
  if (topic.overview) parts.push('', '## Synthesis', '', topic.overview.trim());
  parts.push('', `## Items (showing ${result.bookmarks.length} of ${result.total})`, '');

  result.bookmarks.forEach((bookmark, index) => {
    parts.push(renderCard(bookmark, index + 1), '');
  });

  console.log(parts.join('\n'));
}

async function commandStats(args: ParsedArgs): Promise<void> {
  const stats = await api<Record<string, unknown>>('api/stats');
  if (args.flags.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(stats)) {
    if (typeof value === 'object' && value !== null) {
      console.log(`${key}: ${JSON.stringify(value)}`);
    } else {
      console.log(`${key}: ${String(value)}`);
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function frontMatter(bookmark: Bookmark): string {
  const topics = (bookmark.topics || []).map(topic => topic.name);
  const lines = [
    '---',
    `ref: "${bookmark.ref}"`,
    `id: "${bookmark.tweetId}"`,
    `url: ${bookmark.url}`,
    `author: "${authorLabel(bookmark)}"`,
    `saved: ${isoDay(bookmark.savedAt)}`,
    `created: ${isoDay(bookmark.createdAt) || 'unknown'}`,
    `archived: ${Boolean(bookmark.archivedAt)}`,
    `topics: [${topics.map(name => JSON.stringify(name)).join(', ')}]`,
    '---',
  ];
  return lines.join('\n');
}

function exportFileName(bookmark: Bookmark): string {
  const username = slugify(bookmark.author?.username || bookmark.author?.name || 'unknown');
  return `${isoDay(bookmark.savedAt)}-${username}-${bookmark.tweetId}.md`;
}

async function commandExport(args: ParsedArgs): Promise<void> {
  const target = String(args.flags.dir || args.positional[0] || 'bookmarks-export');
  const dir = resolve(target);
  const bookmarks = await fetchAllBookmarks({ view: 'all' });
  const topics = await api<TopicListResult>('api/topics');

  mkdirSync(dir, { recursive: true });

  for (const bookmark of bookmarks) {
    const body = `${frontMatter(bookmark)}\n\n${renderBookmark(bookmark)}\n`;
    writeFileSync(join(dir, exportFileName(bookmark)), body, 'utf8');
  }

  const jsonl = bookmarks
    .map(bookmark =>
      JSON.stringify({
        id: bookmark.tweetId,
        url: bookmark.url,
        author: authorLabel(bookmark),
        savedAt: bookmark.savedAt,
        createdAt: bookmark.createdAt,
        topics: (bookmark.topics || []).map(topic => topic.name),
        archived: Boolean(bookmark.archivedAt),
        summary: bookmark.summary,
        summaryEn: bookmark.summaryEn,
        text: bookmark.text,
        links: (bookmark.links || []).map(link => ({ url: link.finalUrl || link.url, title: link.title })),
        transcripts: (bookmark.transcripts || [])
          .filter(transcript => transcript.status === 'done' && transcript.text)
          .map(transcript => ({
            source: transcript.source,
            lang: transcript.lang,
            text: transcript.text,
          })),
        file: exportFileName(bookmark),
      }),
    )
    .join('\n');
  writeFileSync(join(dir, 'bookmarks.jsonl'), `${jsonl}\n`, 'utf8');

  const index = [
    '# X Bookmark Vault export',
    '',
    `Exported ${bookmarks.length} bookmarks on ${new Date().toISOString().slice(0, 10)}.`,
    'One markdown file per bookmark (YAML front matter), plus `bookmarks.jsonl` for ingestion.',
    '',
    '## Topics',
    '',
    ...topics.topics.map(
      topic => `- **${topic.name}** (\`${topic.slug}\`) — ${topic.count} items`,
    ),
  ].join('\n');
  writeFileSync(join(dir, 'INDEX.md'), `${index}\n`, 'utf8');

  console.error(`Exported ${bookmarks.length} bookmarks to ${dir}`);
  console.error('  INDEX.md, bookmarks.jsonl, and one .md per bookmark');
}

function commandConfig(args: ParsedArgs): void {
  const path = configPath();

  if (typeof args.flags.password === 'string') {
    const url = (typeof args.flags.url === 'string' ? args.flags.url : DEFAULT_URL).replace(/\/+$/, '');
    const password = args.flags.password;
    if (!password.trim()) throw new Error('--password must not be empty');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ url, password }, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${path}`);
    return;
  }

  try {
    const config = loadConfig();
    const masked = config.password.length > 4
      ? `${config.password.slice(0, 2)}…${config.password.slice(-2)} (${config.password.length} chars)`
      : '****';
    console.log(`url:      ${config.url}`);
    console.log(`password: ${masked}`);
    console.log(`source:   ${config.source}`);
    console.log(`config:   ${path}`);
  } catch (error) {
    console.log(`config: ${path} (not written yet)`);
    console.log((error as Error).message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// MCP server (stdio, newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MCP_TOOLS = [
  {
    name: 'search_bookmarks',
    description:
      "Search the user's private X/Twitter bookmark vault. Matches post text, AI summaries, " +
      'authors, linked-page text and topic names. Every whitespace-separated term must match. ' +
      'Searches both active and archived items. Returns compact cards (author, date, topics, summary excerpt, URL, tweet id).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords, e.g. "claude code agents" or "postgres index".',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (1-50, default 10).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bookmark',
    description:
      'Fetch one saved bookmark in full: the Turkish AI summary, its English translation, original post, ' +
      'quoted post, X Article, linked-page text, topics, archive state, and alternative summary versions. Accepts the short id shown on ' +
      'each card (e.g. "k7f3"), a tweet id, or an x.com status URL.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Short bookmark id from search results (e.g. "k7f3"), a tweet id, or an x.com status URL.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_topics',
    description:
      'List the AI-induced topics of the vault with their rolling syntheses and bookmark counts. ' +
      'Use this to get an overview before searching for a specific subject.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_topic',
    description:
      'Show one topic: its synthesis plus the saved posts filed under it. Use list_topics first to learn slugs.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Topic slug from list_topics.' },
        limit: { type: 'number', description: 'Maximum items (1-100, default 50).' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
];

const MCP_INSTRUCTIONS =
  'This server exposes the user\'s personal X bookmark archive. When the user refers to something ' +
  'they saved or asks what they have read about a subject, call search_bookmarks first, then ' +
  'get_bookmark for the entries worth quoting. Prefer quoting the AI summary and original post text ' +
  'verbatim. Summaries have a Turkish primary (`summary`) and often an English translation (`summaryEn`); ' +
  'archived items are still part of the archive and are included in search.';

async function callTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'search_bookmarks': {
      const query = String(input.query || '').trim();
      if (!query) throw new Error('`query` is required.');
      const limit = clampLimit(String(input.limit ?? 10), 10, 50);
      const result = await api<ListResult>('api/bookmarks', { q: query, limit, view: 'all' });
      if (!result.bookmarks.length) return `No bookmarks matched “${query}”.`;
      return [
        `${result.total} match${result.total === 1 ? '' : 'es'} for “${query}”:`,
        '',
        ...result.bookmarks.map((bookmark, index) => renderCard(bookmark, index + 1)),
      ].join('\n');
    }

    case 'get_bookmark': {
      const id = bookmarkIdArg(String(input.id || ''));
      const result = await api<GetResult>(`api/bookmarks/${id}`);
      return renderBookmark(result.bookmark);
    }

    case 'list_topics': {
      const data = await api<TopicListResult>('api/topics');
      if (!data.topics.length) return 'No topics yet.';
      return data.topics
        .map(topic => {
          const header = `## ${topic.name} (\`${topic.slug}\`) — ${topic.count} items`;
          const parts = [header];
          if (topic.description) parts.push(topic.description);
          if (topic.overview) parts.push('', topic.overview.trim());
          return parts.join('\n');
        })
        .join('\n\n');
    }

    case 'get_topic': {
      const slug = String(input.slug || '').trim();
      if (!slug) throw new Error('`slug` is required.');
      const limit = clampLimit(String(input.limit ?? 50), 50, 100);
      const topics = await api<TopicListResult>('api/topics');
      const topic = topics.topics.find(
        item => item.slug === slug || item.name.toLowerCase() === slug.toLowerCase(),
      );
      if (!topic) {
        return `Unknown topic “${slug}”. Known slugs: ${topics.topics.map(item => item.slug).join(', ') || '(none)'}`;
      }
      const result = await api<ListResult>('api/bookmarks', { topic: topic.slug, limit, view: 'all' });
      const counts = `${topic.count} active${topic.archivedCount ? `, ${topic.archivedCount} archived` : ''}`;
      const parts = [`# ${topic.name} — ${counts}`];
      if (topic.description) parts.push('', topic.description);
      if (topic.overview) parts.push('', '## Synthesis', '', topic.overview.trim());
      parts.push('', ...result.bookmarks.map((bookmark, index) => renderCard(bookmark, index + 1)));
      return parts.join('\n');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: McpRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function sendError(id: McpRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleMcpMessage(raw: string): Promise<void> {
  let request: McpRequest;
  try {
    request = JSON.parse(raw) as McpRequest;
  } catch {
    sendError(null, -32700, 'Parse error');
    return;
  }

  const id = request.id;
  const isNotification = id === undefined || id === null;

  try {
    switch (request.method) {
      case 'initialize': {
        const requested = request.params?.protocolVersion;
        sendResult(id, {
          protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'xbv', version: VERSION },
          instructions: MCP_INSTRUCTIONS,
        });
        return;
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;

      case 'ping':
        sendResult(id, {});
        return;

      case 'tools/list':
        sendResult(id, { tools: MCP_TOOLS });
        return;

      case 'tools/call': {
        const params = (request.params || {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = String(params.name || '');
        try {
          const text = await callTool(name, params.arguments || {});
          sendResult(id, { content: [{ type: 'text', text }] });
        } catch (error) {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        if (isNotification) return;
        sendError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (isNotification) return;
    sendError(id, -32603, (error as Error).message);
  }
}

async function runMcp(): Promise<void> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Serialize handling so responses keep request order.
  let queue: Promise<void> = Promise.resolve();
  rl.on('line', line => {
    const text = line.trim();
    if (!text) return;
    queue = queue.then(() => handleMcpMessage(text));
  });

  await new Promise<void>(resolveClose => {
    rl.on('close', () => {
      queue.finally(() => resolveClose());
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const HELP = `xbv ${VERSION} — read the X Bookmark Vault from the terminal or an AI client.

Usage:
  xbv search <words> [--limit 10] [--json]   search text, summaries, authors, topics
  xbv show <id|x.com URL> [--json]           one bookmark (short id, tweet id, or URL)
  xbv recent [--limit 10] [--json]           newest bookmarks
  xbv topics [--json]                        AI topics + rolling syntheses
  xbv topic <slug> [--limit 50] [--json]     one topic's synthesis + items
  xbv export [--dir ./dir]                   markdown + jsonl for local RAG
  xbv stats [--json]                         archive counts
  xbv config [--password <pw>] [--url <u>]   show or write credentials
  xbv mcp                                    stdio MCP server for AI clients

Configuration:
  XBV_URL + XBV_PASSWORD      environment (wins)
  ~/.config/xbv/config.json   { "url": "...", "password": "..." }
  .dev.vars                   fallback when run inside the repo

MCP examples:
  claude mcp add xbv -- xbv mcp
  codex mcp add xbv -- xbv mcp
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional.shift() || 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case 'search':
      return commandSearch(args);
    case 'recent':
    case 'list':
      return commandRecent(args);
    case 'show':
    case 'get':
      return commandShow(args);
    case 'topics':
      return commandTopics(args);
    case 'topic':
      return commandTopic(args);
    case 'stats':
      return commandStats(args);
    case 'export':
      return commandExport(args);
    case 'config':
      return commandConfig(args);
    case 'mcp':
      return runMcp();
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`xbv: ${(error as Error).message}`);
  process.exit(1);
});
