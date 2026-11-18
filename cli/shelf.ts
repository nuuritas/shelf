#!/usr/bin/env bun
/**
 * shelf — read the Shelf archive from a terminal or an AI client.
 *
 * The vault lives in a Cloudflare Worker you deploy yourself. This CLI talks to
 * its JSON API with the same `APP_PASSWORD` the web login uses, so nothing has
 * to be synced: the Worker stays the single source of truth.

 * Point it at your instance once:
 *   shelf config --url https://your-worker.workers.dev --password '<app password>'
 *
 * Two ways to use it with AI:
 *   1. `shelf search ...` / `shelf show k7f3 ...` — pipe markdown into any chat.
 *   2. `shelf mcp` — a stdio MCP server so Claude Code/Desktop, Codex, Cursor
 *      etc. can search the archive themselves via tools.
 *
 * Run with bun (no dependencies, no build step):
 *   shelf search "claude code"
 *   shelf show 1985100000000000000
 *   shelf export --dir ~/Documents/bookmarks
 *   shelf mcp
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectYoutubeIds, parseTranscriptBody, youtubeVideoId } from '../src/transcript.ts';
import { labelSlug } from '../src/labels.ts';
import { commandLogin, commandLogout } from './login.ts';
import {
  activateAccount,
  configPath,
  legacyConfigPath,
  readConfigFile,
  saveAccount,
  type ReadConfig,
} from './config.ts';
import type {
  Bookmark,
  GetResult,
  LabelListResult,
  ListResult,
  SaveResult,
  StoreTranscriptsResult,
  SummaryVersion,
  TopicListResult,
} from '../src/types.ts';

const VERSION = '0.1.0';
/** Last-resort default: a local `bun run dev` server. */
const DEFAULT_URL = 'http://127.0.0.1:8787';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Config {
  url: string;
  password: string;
  /** Where the password came from, for `shelf config`. */
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
  // XBV_* is the pre-rename spelling; keep reading it so existing shells work.
  const url = (process.env.SHELF_URL || process.env.XBV_URL || '').trim().replace(/\/+$/, '');
  const password = process.env.SHELF_PASSWORD || process.env.XBV_PASSWORD || '';

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
      '  SHELF_PASSWORD (and optionally SHELF_URL)',
      `  ${configPath()}  →  { "url": "${DEFAULT_URL}", "password": "..." }`,
      'or run from a checkout that contains .dev.vars.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api<T>(
  path: string,
  params?: Record<string, string | number>,
  init?: RequestInit,
): Promise<T> {
  const config = loadConfig();
  const url = new URL(path, `${config.url}/`);

  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.password}`,
      Accept: 'application/json',
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
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
          'Update it with `shelf config --password <new>` or fix .dev.vars/SHELF_PASSWORD.',
      );
    }
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }

  return (body ? JSON.parse(body) : null) as T;
}

function apiPost<T>(path: string, payload: unknown): Promise<T> {
  return api<T>(path, undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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
  if (/^[A-Za-z0-9_-]{1,30}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/\/status(?:es)?\/(\d{1,25})/);
  if (match) return match[1];
  const idQuery = trimmed.match(/[?&]id=(\d{1,25})/);
  if (idQuery) return idQuery[1];
  throw new Error(`Not a bookmark id, post id, or URL: ${value}`);
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
  // A note was written by an agent, so that is its author; it has no post
  // handle to show, and "unknown author" would hide who actually wrote it.
  if (bookmark.kind === 'note') return bookmark.agent?.name || 'AI agent';
  const username = bookmark.author?.username;
  if (username) return `@${username}`;
  return bookmark.author?.name || 'unknown author';
}

function topicNames(bookmark: Bookmark): string {
  return (bookmark.topics || []).map(topic => topic.name).join(', ');
}

/** The reader's own tags, as they were spelled. */
function labelNames(bookmark: Bookmark): string {
  return (bookmark.labels || []).map(label => label.name).join(', ');
}

/** Where a row points: the link for a save, the note's own id or citation for a note. */
function rowTarget(bookmark: Bookmark): string {
  if (bookmark.kind === 'note') {
    return bookmark.sourceUrl || bookmark.tweetId || bookmark.ref || '';
  }
  return bookmark.url || '';
}

function renderCard(bookmark: Bookmark, index: number): string {
  const flags = bookmark.archivedAt ? ' · archived' : '';
  const lines = [`${index}. ${authorLabel(bookmark)} · ${isoDay(bookmark.savedAt)}${flags} · ${rowTarget(bookmark)}`];
  const topics = topicNames(bookmark);
  if (topics) lines.push(`   topics: ${topics}`);
  const labels = labelNames(bookmark);
  if (labels) lines.push(`   labels: ${labels}`);
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
  if (bookmark.kind === 'note') return renderNote(bookmark);

  const lines: string[] = [];

  lines.push(`# ${authorLabel(bookmark)} — ${isoDay(bookmark.createdAt || bookmark.savedAt)}`);
  lines.push('');
  lines.push(bookmark.url);

  const meta = [`Saved ${isoDay(bookmark.savedAt)}`];
  const topics = topicNames(bookmark);
  if (topics) meta.push(`Topics: ${topics}`);
  const labels = labelNames(bookmark);
  if (labels) meta.push(`Labels: ${labels}`);
  if (bookmark.archivedAt) meta.push('Archived');
  if (bookmark.ref) meta.push(`id: ${bookmark.ref}`);
  meta.push(`post: ${bookmark.tweetId}`);
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

function renderNote(bookmark: Bookmark): string {
  const agent = bookmark.agent;
  const attribution = [agent?.name, agent?.model].filter(Boolean).join(' · ') || 'AI agent';
  const lines = [
    `# ${bookmark.title || 'Untitled note'}`,
    '',
    `_Written by ${attribution} · AI-generated_`,
  ];
  if (bookmark.sourceUrl) lines.push('', `Source: ${bookmark.sourceUrl}`);
  const meta = [`Saved ${isoDay(bookmark.savedAt)}`];
  if (bookmark.topics?.length) meta.push(`Topics: ${topicNames(bookmark)}`);
  if (bookmark.labels?.length) meta.push(`Labels: ${labelNames(bookmark)}`);
  if (bookmark.archivedAt) meta.push('Archived');
  if (bookmark.ref) meta.push(`id: ${bookmark.ref}`);
  meta.push(`note: ${bookmark.tweetId}`);
  lines.push('', meta.join(' · '));

  if (bookmark.summary) {
    lines.push('', '## Abstract (agent-written)', '', bookmark.summary.trim());
  }

  let body = bookmark.format === 'html' ? bookmark.text.trim() : String(bookmark.content || bookmark.text);
  if (bookmark.format === 'markdown' && bookmark.title) {
    const heading = /^\s{0,3}#\s+(.+?)\s*\n?/.exec(body);
    if (heading && heading[1].trim().toLowerCase() === bookmark.title.trim().toLowerCase()) {
      body = body.replace(heading[0], '');
    }
  }
  lines.push('', body.trim());
  if (bookmark.format === 'html') {
    lines.push('', '_HTML note: extracted text shown; open the web view for the full document._');
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

function authoringGuide(): string {
  try {
    const path = fileURLToPath(new URL('../docs/AGENT-POSTS.md', import.meta.url));
    return readFileSync(path, 'utf8');
  } catch {
    return [
      'Shelf agent posts',
      '',
      'Use markdown for text research; HTML only for visuals and only as a',
      'self-contained, script-free document. POST /api/posts with',
      '{ format, content, title?, summary?, sourceUrl?, clientId?, ref?, agent? }.',
      'Limits: markdown 256 KB, HTML 1 MB, title 200 chars, summary 4,000 chars.',
      'HTML is rendered in a sandboxed iframe; scripts never run.',
      'Give the document light, white and dark picked inside it, using the app',
      'palette rather than invented colours.',
    ].join('\n');
  }
}

const ADD_HELP = `shelf add - save an AI-written research note

Usage:
  shelf add <file|-> [flags]

Input:
  <file>        path to a .md, .markdown, .html or .htm file
  -             read from stdin

Flags:
  --format <f>        markdown | html (default: from the extension, else markdown)
  --title <text>      title shown on the card (default: first heading, else first line)
  --agent <name>      who wrote it (default: "Shelf CLI")
  --model <name>      model that wrote it (optional)
  --tool <name>       tool that wrote it (default: "shelf-cli")
  --summary <text>    optional 1-3 sentence abstract, stored as agent-written
  --source-url <url>  optional primary source, http(s) only
  --label <names>     comma-separated tags, e.g. "reading, design" (max 12)
  --client-id <id>    stable id: re-posting the same value updates one note
  --ref <ref>         update the note with this ref in place (keeps its link)
  --json              print the full API result

Limits: markdown 256 KB, HTML 1 MB, title 200 chars, summary 4,000 chars.

HTML rules: a complete document with inline CSS/SVG, no scripts, forms or
external assets. HTML is stored untrusted and rendered sandboxed.

Colour: give the note light, white and dark picked inside the document; take
its colours from the app palette, not invented ones. Mechanism: \`shelf guide\`.

Guide: docs/AGENT-POSTS.md — run \`shelf guide\` for the full authoring contract.

Examples:
  shelf add ./research.md --title "How agent memory works" --agent "Claude Code"
  shelf add ./notes.md --label "reading, design" --summary "One line."
  cat note.md | shelf add - --title "Notes" --client-id daily-2026-11-13
`;

function inferNoteFormat(path: string): 'markdown' | 'html' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return null;
}

async function commandAdd(args: ParsedArgs): Promise<void> {
  const target = args.positional[0];
  if (args.flags.help || target === '--help') {
    console.log(ADD_HELP);
    return;
  }
  if (!target) {
    console.log(ADD_HELP);
    throw new Error('Usage: shelf add <file|-> [--format markdown|html] [--title "..."]');
  }

  let content: string;
  try {
    content = target === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(target), 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${target}: ${(error as Error).message}`);
  }
  if (!content.trim()) throw new Error('The note is empty.');

  const requested = typeof args.flags.format === 'string' ? args.flags.format.toLowerCase() : '';
  const format = requested || inferNoteFormat(target) || 'markdown';
  if (format !== 'markdown' && format !== 'html') {
    throw new Error('--format must be "markdown" or "html".');
  }

  const payload = {
    format,
    content,
    title: typeof args.flags.title === 'string' ? args.flags.title : undefined,
    summary: typeof args.flags.summary === 'string' ? args.flags.summary : undefined,
    sourceUrl: typeof args.flags['source-url'] === 'string' ? args.flags['source-url'] : undefined,
    labels: typeof args.flags.label === 'string' ? args.flags.label : undefined,
    clientId: typeof args.flags['client-id'] === 'string' ? args.flags['client-id'] : undefined,
    ref: typeof args.flags.ref === 'string' ? args.flags.ref : undefined,
    agent: {
      name: typeof args.flags.agent === 'string' ? args.flags.agent : 'Shelf CLI',
      model: typeof args.flags.model === 'string' ? args.flags.model : '',
      tool: typeof args.flags.tool === 'string' ? args.flags.tool : 'shelf-cli',
    },
  };

  const result = await apiPost<SaveResult>('api/posts', payload);
  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const bookmark = result.bookmark;
  const size = `${(content.length / 1024).toFixed(1)} KB`;
  console.log(
    `${result.created ? 'Added' : 'Updated'} #${bookmark?.ref ?? '?'} ${bookmark?.tweetId ?? ''} (${format}, ${size})`,
  );
  if (bookmark?.title) console.log(`  ${bookmark.title}`);
  if (bookmark?.labels?.length) console.log(`  labels: ${labelNames(bookmark)}`);
  const config = loadConfig();
  console.log(`  ${config.url.replace(/\/$/, '')}/?layout=saves#bookmark-${bookmark?.tweetId ?? ''}`);
}

async function commandSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ').trim();
  if (!query) {
    throw new Error('Usage: shelf search <words> [--limit 10] [--label reading] [--json]');
  }

  const limit = clampLimit(args.flags.limit, 10, 50);
  const label = typeof args.flags.label === 'string' ? labelSlug(args.flags.label) : '';
  const result = await api<ListResult>('api/bookmarks', {
    q: query,
    limit,
    view: 'all',
    ...(label ? { label } : {}),
  });

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
  const label = typeof args.flags.label === 'string' ? labelSlug(args.flags.label) : '';
  const result = await api<ListResult>('api/bookmarks', {
    limit,
    ...(label ? { label } : {}),
  });

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
  if (!target) throw new Error('Usage: shelf show <id | post id | URL> [--json]');

  const id = bookmarkIdArg(target);
  const result = await api<GetResult>(`api/bookmarks/${id}`);

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderBookmark(result.bookmark));
}

async function commandYoutube(args: ParsedArgs): Promise<void> {
  const limit = Math.max(1, Math.min(Number(args.flags.limit || 20) || 20, 100));
  const gapSec = Math.max(1, Math.min(Number(args.flags.gap || 5) || 5, 60));
  const dryRun = Boolean(args.flags['dry-run']);
  const bookmarks = await fetchAllBookmarks({ view: 'all' });
  let processed = 0;
  let skipped = 0;
  let halted = false;

  for (const bookmark of bookmarks) {
    if (processed >= limit) break;
    const ids = collectYoutubeIds(bookmark);
    if (!ids.length) continue;

    const done = new Set(
      (bookmark.transcripts || [])
        .filter(transcript => transcript.status === 'done')
        .map(transcript => youtubeVideoId(transcript.url))
        .filter((id): id is string => Boolean(id)),
    );

    for (const id of ids) {
      if (processed >= limit) break;
      if (done.has(id)) {
        skipped++;
        continue;
      }

      const label = bookmark.ref || bookmark.tweetId;
      console.log(`${dryRun ? 'Would fetch' : 'Fetching'} ${id} for #${label}…`);
      if (dryRun) {
        processed++;
        continue;
      }

      try {
        const transcript = await fetchLocalTranscript(id);
        const result = await apiPost<StoreTranscriptsResult>(
          `api/bookmarks/${label}/transcripts`,
          {
            transcripts: [
              {
                url: `https://www.youtube.com/watch?v=${id}`,
                source: 'youtube',
                provider: 'local',
                lang: transcript.lang,
                text: transcript.text,
                durationSec: transcript.durationSec,
                bytes: null,
                status: 'done',
                error: null,
                at: new Date().toISOString(),
              },
            ],
          },
        );
        processed++;
        console.log(
          `  stored ${transcript.text.length} chars; ${
            result.queued ? 'summary queued' : 'summary not queued'
          }`,
        );
      } catch (error) {
        processed++;
        console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
        if (isRateLimited(error)) {
          halted = true;
          console.error('  stopping this run so the rest of the batch does not burn into 429s.');
        }
      }

      if (halted) break;
      if (processed < limit) await sleep(gapSec * 1000);
    }
    if (halted) break;
  }

  if (halted) {
    console.log('\nStopped early: YouTube rate limited this IP. Re-run in about 90 seconds.');
  }
  console.log(
    `\n${processed} transcript(s) ${dryRun ? 'would be fetched' : 'processed'}, ${skipped} already done.`,
  );
}

const execFileAsync = promisify(execFile);

/** `out/yt/fetch.sh` exit code 2: YouTube answered 429 for this IP. */
const RATE_LIMIT_EXIT = 2;

/** The local yt-dlp wrapper; optional, so a bare checkout keeps working. */
const YT_FETCH_SCRIPT =
  process.env.SHELF_YT_SCRIPT ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'yt', 'fetch.sh');

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isRateLimited(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { rateLimited?: boolean }).rateLimited);
}

/** Last cue end in a WebVTT file, in whole seconds; null when it has no cues. */
function vttDurationSec(raw: string): number | null {
  const last = [...raw.matchAll(/-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)].at(-1);
  if (!last) return null;

  const seconds = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) + Number(last[4]) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

/**
 * Read captions through `out/yt/fetch.sh`, which caches by video id and needs no
 * key or account. Returns null when the script is not installed, so the caller
 * can fall back to the third-party tool.
 */
async function fetchTranscriptWithYtDlp(
  videoId: string,
): Promise<{ text: string; lang: string | null; durationSec: number | null } | null> {
  if (!existsSync(YT_FETCH_SCRIPT)) return null;

  let output: string;
  try {
    const { stdout } = await execFileAsync(YT_FETCH_SCRIPT, [videoId], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    output = String(stdout);
  } catch (error) {
    if ((error as { code?: number | string }).code === RATE_LIMIT_EXIT) {
      const limited = new Error('YouTube is rate limiting this IP.') as Error & { rateLimited: true };
      limited.rateLimited = true;
      throw limited;
    }
    throw error;
  }

  const file = output.trim().split('\n').filter(Boolean).at(-1);
  if (!file) throw new Error('out/yt/fetch.sh printed no caption file.');

  const raw = readFileSync(file, 'utf8');
  const { text } = parseTranscriptBody(raw);
  if (!text) throw new Error('No transcript text returned.');

  return {
    text,
    lang: /\.([A-Za-z][A-Za-z-]*)\.vtt$/.exec(file)?.[1] ?? null,
    durationSec: vttDurationSec(raw),
  };
}

async function fetchLocalTranscript(
  videoId: string,
): Promise<{ text: string; lang: string | null; durationSec: number | null }> {
  let localError: unknown = null;
  try {
    const viaYtDlp = await fetchTranscriptWithYtDlp(videoId);
    if (viaYtDlp) return viaYtDlp;
  } catch (error) {
    // A 429 would fail the fallback the same way and only costs the cooldown.
    if (isRateLimited(error)) throw error;
    localError = error;
  }

  try {
    return await fetchTranscriptWithTool(videoId);
  } catch (error) {
    throw localError ?? error;
  }
}

async function fetchTranscriptWithTool(
  videoId: string,
): Promise<{ text: string; lang: string | null; durationSec: number | null }> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['x', 'get-youtube-transcript', videoId, '--format', 'json'],
    { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );

  const data = JSON.parse(String(stdout)) as {
    text?: string;
    language?: string;
    segments?: Array<{ start?: number; duration?: number }>;
  };
  const text = String(data.text || '').trim();
  if (!text) throw new Error('No transcript text returned.');

  const last = data.segments?.at(-1);
  const end = Number(last?.start ?? 0) + Number(last?.duration ?? 0);

  return {
    text,
    lang: data.language || null,
    durationSec: Number.isFinite(end) && end > 0 ? end : null,
  };
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
  if (!slug) throw new Error('Usage: shelf topic <slug> [--limit 50] [--json]');

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
  const labels = (bookmark.labels || []).map(label => label.name);
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
    `labels: [${labels.map(name => JSON.stringify(name)).join(', ')}]`,
    '---',
  ];
  return lines.join('\n');
}

function exportFileName(bookmark: Bookmark): string {
  if (bookmark.kind === 'note') {
    const slug = slugify(bookmark.title || 'untitled-note');
    const extension = bookmark.format === 'html' ? 'html' : 'md';
    return `${isoDay(bookmark.savedAt)}-note-${slug}.${extension}`;
  }
  const username = slugify(bookmark.author?.username || bookmark.author?.name || 'unknown');
  return `${isoDay(bookmark.savedAt)}-${username}-${bookmark.tweetId}.md`;
}

async function commandExport(args: ParsedArgs): Promise<void> {
  const target = String(args.flags.dir || args.positional[0] || 'bookmarks-export');
  const dir = resolve(target);
  const bookmarks = await fetchAllBookmarks({ view: 'all' });
  const topics = await api<TopicListResult>('api/topics');
  const labels = await api<LabelListResult>('api/labels').catch(
    (): LabelListResult => ({ labels: [] }),
  );

  mkdirSync(dir, { recursive: true });

  for (const bookmark of bookmarks) {
    // An HTML note is already a complete document; do not wrap it in markdown.
    const body =
      bookmark.kind === 'note' && bookmark.format === 'html'
        ? String(bookmark.content || '')
        : `${frontMatter(bookmark)}\n\n${renderBookmark(bookmark)}\n`;
    writeFileSync(join(dir, exportFileName(bookmark)), body, 'utf8');
  }

  const jsonl = bookmarks
    .map(bookmark =>
      JSON.stringify({
        id: bookmark.tweetId,
        kind: bookmark.kind,
        format: bookmark.format,
        title: bookmark.title,
        agent: bookmark.agent,
        url: bookmark.url,
        author: authorLabel(bookmark),
        savedAt: bookmark.savedAt,
        createdAt: bookmark.createdAt,
        topics: (bookmark.topics || []).map(topic => topic.name),
        labels: (bookmark.labels || []).map(label => label.name),
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
    '# Shelf export',
    '',
    `Exported ${bookmarks.length} bookmarks on ${new Date().toISOString().slice(0, 10)}.`,
    'One markdown file per bookmark (YAML front matter), plus `bookmarks.jsonl` for ingestion.',
    '',
    '## Topics',
    '',
    ...topics.topics.map(
      topic => `- **${topic.name}** (\`${topic.slug}\`) — ${topic.count} items`,
    ),
    '',
    '## Labels',
    '',
    ...(labels.labels.length
      ? labels.labels.map(
          label => `- **${label.name}** (\`${label.slug}\`) — ${label.count} items`,
        )
      : ['_No labels yet._']),
  ].join('\n');
  writeFileSync(join(dir, 'INDEX.md'), `${index}\n`, 'utf8');

  console.error(`Exported ${bookmarks.length} bookmarks to ${dir}`);
  console.error('  INDEX.md, bookmarks.jsonl, and one .md per bookmark');
}

function printAccounts(config: ReadConfig): void {
  for (const entry of config.accounts) {
    const mark = entry.url === config.url ? '*' : ' ';
    const who = entry.account.email ? `  (${entry.account.email})` : '';
    console.log(`  ${mark} ${entry.url}${who}`);
  }
}

function commandUse(args: ParsedArgs): void {
  const target = args.positional[0] || '';
  if (!target) {
    const existing = readConfigFile();
    if (!existing) {
      throw new Error(`No saved accounts in ${configPath()}. Run \`shelf login\` first.`);
    }
    console.log(`Saved accounts in ${existing.source}:`);
    printAccounts(existing);
    console.log('Switch with `shelf use <url|email>`.');
    return;
  }

  const entry = activateAccount(target);
  const who = entry.account.email ? ` as ${entry.account.email}` : '';
  console.log(`Now using ${entry.url}${who}.`);
}

function commandConfig(args: ParsedArgs): void {
  const path = configPath();

  if (typeof args.flags.password === 'string') {
    const existing = readConfigFile();
    const flagUrl = typeof args.flags.url === 'string' ? args.flags.url : '';
    const url = flagUrl || existing?.url || '';
    if (!url) {
      throw new Error('Pass --url <https://your-worker.workers.dev> the first time you save a password.');
    }
    const password = args.flags.password;
    if (!password.trim()) throw new Error('--password must not be empty');
    const saved = saveAccount(url, password);
    console.log(`Wrote ${saved.path} for ${saved.url}`);
    return;
  }

  if (typeof args.flags.use === 'string' && args.flags.use.trim()) {
    return commandUse({ positional: [args.flags.use], flags: {} });
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

    const saved = readConfigFile();
    if (saved && saved.accounts.length) {
      if (saved.accounts.length > 1) {
        console.log('accounts:');
        printAccounts(saved);
        console.log('  * active — switch with `shelf use <url|email>`');
      } else {
        console.log('accounts: 1 — `shelf login --url <other>` keeps both');
      }
    }
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
      "Search the user's private Shelf archive (X and LinkedIn). Matches post text, AI summaries, " +
      'authors, linked-page text, topic and label names. Every whitespace-separated term must match. ' +
      'Searches both active and archived items. Returns compact cards (author, date, topics, labels, summary excerpt, URL, post id).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords, e.g. "claude code agents" or "postgres index".',
        },
        label: {
          type: 'string',
          description: 'Optional label to narrow to one tag, e.g. "reading".',
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
      'each card (e.g. "k7f3"), a post id, or an x.com status URL.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Short bookmark id from search results (e.g. "k7f3"), a post id, or an x.com status URL.',
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
  {
    name: 'create_post',
    description:
      'Save an AI-written research note to the user\'s private Shelf archive. Use only when the user ' +
      'asks to save, publish or keep a research result (not for saving someone else\'s URL). Prefer ' +
      'markdown; HTML only for visuals. Read get_authoring_guide first for the HTML contract and limits. ' +
      'Re-posting with the same clientId updates that one note; `ref` updates a note in place.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['markdown', 'html'] },
        content: { type: 'string', description: 'The full note body (markdown or a self-contained HTML document).' },
        title: { type: 'string', description: 'Title, max 200 characters.' },
        summary: { type: 'string', description: 'Optional 1-3 sentence abstract, max 4,000 characters.' },
        sourceUrl: { type: 'string', description: 'Optional primary source URL (http/https).' },
        labels: {
          anyOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string', description: 'Comma-separated tags.' },
          ],
          description:
            'Optional tags the reader can filter by, e.g. ["reading","design"] or "reading, design". Max 12.',
        },
        clientId: { type: 'string', description: 'Stable id so a retry updates the same note.' },
        ref: { type: 'string', description: 'Short ref of an existing note to update in place.' },
        agent: {
          type: 'object',
          description: 'Who wrote the note; shown on the card.',
          properties: {
            name: { type: 'string', description: 'Agent name, e.g. Claude Code.' },
            model: { type: 'string', description: 'Model that wrote the note.' },
            tool: { type: 'string', description: 'Client or tool id, e.g. claude-code.' },
          },
          additionalProperties: false,
        },
      },
      required: ['format', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_authoring_guide',
    description:
      'Return the Shelf agent-post guide: when to write a note, markdown vs HTML, metadata, limits, ' +
      'the HTML security contract, and examples. Call this before create_post.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const MCP_INSTRUCTIONS =
  'This server exposes the user\'s personal Shelf archive. When the user refers to something ' +
  'they saved or asks what they have read about a subject, call search_bookmarks first, then ' +
  'get_bookmark for the entries worth quoting. Prefer quoting the AI summary and original post text ' +
  'verbatim. Summaries have a Turkish primary (`summary`) and often an English translation (`summaryEn`); ' +
  'archived items are still part of the archive and are included in search. ' +
  'To keep a research result, call get_authoring_guide and then create_post; only do that when the ' +
  'user asks to save, publish or keep it. Prefer markdown; HTML must be self-contained, script-free ' +
  'and is rendered sandboxed.';

async function callTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'create_post': {
      const content = String(input.content || '');
      if (!content.trim()) throw new Error('`content` is required.');
      // The MCP caller can name itself, matching the guide's metadata table;
      // the tool's own identity is only the fallback.
      const agentInput =
        input.agent && typeof input.agent === 'object' && !Array.isArray(input.agent)
          ? (input.agent as Record<string, unknown>)
          : {};
      const result = await apiPost<SaveResult>('api/posts', {
        format: String(input.format || 'markdown'),
        content,
        title: input.title,
        summary: input.summary,
        sourceUrl: input.sourceUrl,
        labels: input.labels,
        clientId: input.clientId,
        ref: input.ref,
        agent: {
          name: String(agentInput.name || 'Shelf MCP'),
          model: String(agentInput.model || ''),
          tool: String(agentInput.tool || 'shelf-mcp'),
        },
      });
      const bookmark = result.bookmark;
      return [
        `${result.created ? 'Saved' : 'Updated'} note #${bookmark?.ref ?? '?'} (${bookmark?.format ?? input.format})`,
        bookmark?.title ? `Title: ${bookmark.title}` : '',
        `Id: ${bookmark?.tweetId ?? ''}`,
        `Read it at ${loadConfig().url.replace(/\/$/, '')}/p/${bookmark?.ref ?? ''}`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'get_authoring_guide':
      return authoringGuide();
    case 'search_bookmarks': {
      const query = String(input.query || '').trim();
      if (!query) throw new Error('`query` is required.');
      const limit = clampLimit(String(input.limit ?? 10), 10, 50);
      const label = String(input.label || '');
      const result = await api<ListResult>('api/bookmarks', {
        q: query,
        limit,
        view: 'all',
        ...(label ? { label: labelSlug(label) } : {}),
      });
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
          serverInfo: { name: 'shelf', version: VERSION },
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

const HELP = `shelf ${VERSION} — read your Shelf archive from the terminal or an AI client.

Usage:
  shelf add <file|-> [--label "a, b"]          save an AI-written research note
  shelf guide                                  print the agent-post authoring guide
  shelf search <words> [--label <slug>]        search text, summaries, authors, topics
  shelf show <id|URL> [--json]                 one bookmark (short id, post id, or URL)
  shelf recent [--limit 10] [--label <slug>]   newest bookmarks
  shelf topics [--json]                        AI topics + rolling syntheses
  shelf topic <slug> [--limit 50] [--json]     one topic's synthesis + items
  shelf export [--dir ./dir]                   markdown + jsonl for local RAG
  shelf stats [--json]                         archive counts
  shelf youtube [--limit 20] [--gap 5] [--dry-run]  fetch missing YouTube transcripts locally
  shelf config [--password <pw>] [--url <u>]   show or write credentials
  shelf use [<url|email>]                      list saved accounts, or switch the active one
  shelf login [--url <u>]                      sign in through the browser
  shelf logout [--all]                         forget the active account (--all: every account)
  shelf mcp                                    stdio MCP server for AI clients

Configuration:
  SHELF_URL + SHELF_PASSWORD  environment (wins)
  ~/.config/shelf/config.json { "url": "...", "password": "...", "accounts": { ... } }
  .dev.vars                   fallback when run inside the repo

  One signed-in instance is active; \`shelf login\` to another keeps both and
  makes the new one active. \`shelf use\` switches back without signing in
  again. SHELF_CONFIG points the CLI at a different credential file.

  XBV_URL / XBV_PASSWORD and ~/.config/xbv/config.json still work as the
  pre-rename fallbacks.

  First run:  shelf config --url https://<worker>.workers.dev --password <pw>

MCP examples:
  claude mcp add shelf -- shelf mcp
  codex mcp add shelf -- shelf mcp
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
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
    case 'add':
      return commandAdd(args);
    case 'guide':
      console.log(authoringGuide());
      return;
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
    case 'youtube':
      return commandYoutube(args);
    case 'export':
      return commandExport(args);
    case 'config':
      return commandConfig(args);
    case 'use':
    case 'switch':
      return commandUse(args);
    case 'login':
      return commandLogin(args.flags);
    case 'logout':
      return commandLogout(args.flags);
    case 'mcp':
      return runMcp();
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`shelf: ${(error as Error).message}`);
  process.exit(1);
});
