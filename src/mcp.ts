/**
 * A hosted MCP endpoint: one `POST /mcp` that speaks JSON-RPC 2.0 over the
 * Streamable HTTP transport. The Worker already owns the archive and the
 * password, so an AI client needs no local install and no second credential
 * store: point it at `https://<worker>/mcp` with the same bearer password the
 * web login uses.
 *
 * The six tools mirror `shelf mcp` in `cli/shelf.ts`, so a client that already
 * knows the CLI contract sees the same names, schemas and output.
 *
 * Stateless by design: no session id, no server-initiated stream. A POST
 * carries one request and gets one JSON response, which the transport allows.
 */
import { labelSlug } from './labels.ts';
import { normalizeNoteInput } from './notes.ts';
import type {
  Bookmark,
  Env,
  GetResult,
  ListResult,
  SaveResult,
  TopicListResult,
} from './types.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_VERSION = '1.0.0';
/** A full HTML note is 1 MB; leave room for the JSON envelope around it. */
const MAX_BODY_BYTES = 2_000_000;

interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResult = Record<string, unknown>;

/** The tools a backend can answer. Rendering lives with the backend, so the
 * transport below stays free of the archive's data shapes. */
export interface McpBackend {
  search(query: string, label: string, limit: number): Promise<string>;
  get(id: string): Promise<string>;
  listTopics(): Promise<string>;
  getTopic(slug: string, limit: number): Promise<string>;
  createPost(input: Record<string, unknown>): Promise<string>;
  guide(): string;
}

const TOOLS = [
  {
    name: 'search_bookmarks',
    description:
      "Search the user's private Shelf archive (X, LinkedIn, YouTube and the web). Matches post text, " +
      'AI summaries, authors, linked-page text, topic and label names. Every whitespace-separated term must match. ' +
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
      'Fetch one saved bookmark in full: the AI summary, its English translation, the original post, ' +
      'quoted post, X Article, linked-page text, topics, archive state, and alternative summary versions. ' +
      'Accepts the short id shown on each card (e.g. "k7f3"), a post id, or an x.com status URL.',
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
      'List the AI-induced topics of the archive with their rolling syntheses and bookmark counts. ' +
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
      "Save an AI-written research note to the user's private Shelf archive. Use only when the user " +
      "asks to save, publish or keep a research result (not for saving someone else's URL). Prefer " +
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

const INSTRUCTIONS =
  "This server exposes the user's personal Shelf archive. When the user refers to something " +
  'they saved or asks what they have read about a subject, call search_bookmarks first, then ' +
  'get_bookmark for the entries worth quoting. Prefer quoting the AI summary and original post text ' +
  'verbatim. Summaries have a primary language and often an English translation; archived items are ' +
  'still part of the archive and are included in search. ' +
  'To keep a research result, call get_authoring_guide and then create_post; only do that when the ' +
  'user asks to save, publish or keep it. Prefer markdown; HTML must be self-contained, script-free ' +
  'and is rendered sandboxed.';

/** The guide `get_authoring_guide` serves, and `shelf guide` prints. Kept
 * compact because an MCP client reads it in a single tool result. */
export const AUTHORING_GUIDE = `# Agent posts: writing a note into Shelf

A note is content you wrote and saved, not a URL someone else wrote. To save
someone else's page, save it as a normal link; Shelf fetches and reads it.

## Markdown or HTML?

- Markdown for text research: findings, summaries, comparisons, code, tables.
  Prefer it.
- HTML only when layout or visuals matter: a chart in inline SVG, a diagram.
  It is rendered in a sandboxed iframe; scripts never run. The library card
  shows its title, abstract and topics, so write a summary for an HTML note.

## Metadata

- title: optional; defaults to the first heading or line. Max 200 characters.
- summary: optional 1-3 sentence abstract, stored as agent-written. Max 4,000.
- sourceUrl: optional primary source; must be http(s).
- clientId: stable id; re-posting updates that one note and keeps its ref.
- ref: short ref of an existing note to update in place (wins over clientId).
- agent: { name, model, tool }; shown on the card as "Written by ...".
- labels: array or comma-separated line, up to 12, each 40 characters.

Never present a note as a human's writing. Do not invent a label taxonomy.

## Limits

Markdown body 256 KB, HTML body 1 MB, title 200 characters, summary 4,000.

## HTML contract

Complete, self-contained document. Inline style and inline SVG only; no
external CSS, JS, fonts or images (https: or data: images only). No script, no
event attributes, no javascript: URLs, no forms, inputs, buttons, iframe,
object or embed. Support light and dark with prefers-color-scheme. Link real
sources; never invent citations.

## Example

POST /api/posts with
{ "format": "markdown", "content": "## Findings\\n\\n- ...",
  "title": "How agent memory works", "summary": "Short abstract.",
  "agent": { "name": "Claude Code", "model": "claude-sonnet-4.5", "tool": "claude-code" } }

Returns { created, bookmark }; 201 for a new note, 200 when clientId or ref
updated one. Only call create_post when the user asks to keep the result.`;

function rpcResult(id: McpRequest['id'], result: unknown): Response {
  return json({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: McpRequest['id'], code: number, message: string, status = 200): Response {
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Handle one Streamable HTTP POST. `backend` answers the tools so this module
 * can be tested without a Durable Object.
 */
export async function handleMcpRequest(request: Request, backend: McpBackend): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'POST, DELETE' } });
  }
  // No server-initiated SSE stream, and no session to end.
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return rpcError(null, -32600, 'Request body is too large.', 413);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return rpcError(null, -32600, 'Request body is too large.', 413);

  let request_: McpRequest;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    request_ = parsed as McpRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  const id = request_.id;
  const isNotification = id === undefined || id === null;

  try {
    switch (request_.method) {
      case 'initialize': {
        const requested = request_.params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'shelf', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return new Response(null, { status: 202 });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });

      case 'tools/call': {
        const params = (request_.params || {}) as { name?: unknown; arguments?: unknown };
        const name = String(params.name || '');
        const args =
          params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          const text = await callTool(name, args, backend);
          return rpcResult(id, { content: [{ type: 'text', text }] });
        } catch (error) {
          return rpcResult(id, {
            content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
            isError: true,
          });
        }
      }

      default:
        if (isNotification) return new Response(null, { status: 202 });
        return rpcError(id, -32601, `Method not found: ${request_.method}`);
    }
  } catch (error) {
    if (isNotification) return new Response(null, { status: 202 });
    return rpcError(id, -32603, (error as Error).message || 'Internal error', 500);
  }
}

async function callTool(
  name: string,
  input: Record<string, unknown>,
  backend: McpBackend,
): Promise<string> {
  switch (name) {
    case 'search_bookmarks': {
      const query = String(input.query || '').trim();
      if (!query) throw new Error('`query` is required.');
      return backend.search(query, String(input.label || ''), clamp(input.limit, 10, 1, 50));
    }
    case 'get_bookmark':
      return backend.get(bookmarkIdArg(String(input.id || '')));
    case 'list_topics':
      return backend.listTopics();
    case 'get_topic': {
      const slug = String(input.slug || '').trim();
      if (!slug) throw new Error('`slug` is required.');
      return backend.getTopic(slug, clamp(input.limit, 50, 1, 100));
    }
    case 'create_post':
      return backend.createPost(input);
    case 'get_authoring_guide':
      return backend.guide();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
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
// Markdown rendering — the same cards `shelf search` and `shelf show` print
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
  if (bookmark.kind === 'note') return bookmark.agent?.name || 'AI agent';
  const username = bookmark.author?.username;
  if (username) return `@${username}`;
  return bookmark.author?.name || 'unknown author';
}

function topicNames(bookmark: Bookmark): string {
  return (bookmark.topics || []).map((topic) => topic.name).join(', ');
}

function labelNames(bookmark: Bookmark): string {
  return (bookmark.labels || []).map((label) => label.name).join(', ');
}

function rowTarget(bookmark: Bookmark): string {
  if (bookmark.kind === 'note') {
    return bookmark.sourceUrl || bookmark.tweetId || bookmark.ref || '';
  }
  return bookmark.url || '';
}

function renderCard(bookmark: Bookmark, index: number): string {
  const flags = bookmark.archivedAt ? ' · archived' : '';
  const lines = [
    `${index}. ${authorLabel(bookmark)} · ${isoDay(bookmark.savedAt)}${flags} · ${rowTarget(bookmark)}`,
  ];
  const topics = topicNames(bookmark);
  if (topics) lines.push(`   topics: ${topics}`);
  const labels = labelNames(bookmark);
  if (labels) lines.push(`   labels: ${labels}`);
  const summary = (bookmark.summary || bookmark.text || '').replace(/\s+/g, ' ').trim();
  if (summary) lines.push(`   ${truncate(summary, 240)}`);
  lines.push(`   id: ${bookmark.ref || bookmark.tweetId}`);
  return lines.join('\n');
}

function renderNote(bookmark: Bookmark): string {
  const agent = bookmark.agent;
  const attribution = [agent?.name, agent?.model].filter(Boolean).join(' · ') || 'AI agent';
  const lines = [`# ${bookmark.title || 'Untitled note'}`, '', `_Written by ${attribution} · AI-generated_`];
  if (bookmark.sourceUrl) lines.push('', `Source: ${bookmark.sourceUrl}`);
  const meta = [`Saved ${isoDay(bookmark.savedAt)}`];
  if (bookmark.topics?.length) meta.push(`Topics: ${topicNames(bookmark)}`);
  if (bookmark.labels?.length) meta.push(`Labels: ${labelNames(bookmark)}`);
  if (bookmark.archivedAt) meta.push('Archived');
  if (bookmark.ref) meta.push(`id: ${bookmark.ref}`);
  meta.push(`note: ${bookmark.tweetId}`);
  lines.push('', meta.join(' · '));
  if (bookmark.summary) lines.push('', '## Abstract (agent-written)', '', bookmark.summary.trim());

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

function renderBookmark(bookmark: Bookmark): string {
  if (bookmark.kind === 'note') return renderNote(bookmark);

  const lines: string[] = [];
  lines.push(`# ${authorLabel(bookmark)} — ${isoDay(bookmark.createdAt || bookmark.savedAt)}`, '');
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
    lines.push('', '## AI summary', '', bookmark.summary.trim());
  } else if (bookmark.summaryStatus === 'pending') {
    lines.push('', '## AI summary', '', `_Still pending (status: ${bookmark.summaryStatus})._`);
  }
  if (bookmark.summaryEn) lines.push('', '## AI summary (English)', '', bookmark.summaryEn.trim());

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
    const heading = link.title || link.siteName || link.url;
    lines.push('', `### ${heading}`, link.finalUrl || link.url);
    if (link.siteName) lines.push(`_${link.siteName}_`);
    if (link.description) lines.push('', truncate(link.description, 400));
    if (link.text) lines.push('', truncate(link.text, 2000));
  }

  for (const version of bookmark.versions || []) {
    const label = version.instruction ? ` — “${version.instruction}”` : '';
    lines.push('', `## Summary v${version.version}${label}`, '', version.summary.trim());
  }

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

  if (bookmark.media?.length) lines.push('', `_Media: ${bookmark.media.length} item(s)._`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The Durable Object backend
// ---------------------------------------------------------------------------

async function storage<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const stub = env.BOOKMARKS.get(env.BOOKMARKS.idFromName('library'));
  const response = await stub.fetch(`https://bookmarks.internal${path}`, init);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Storage returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const record =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Storage returned HTTP ${response.status}.`;
    throw new Error(record);
  }
  return payload as T;
}

/** Bind the tools to this Worker's archive. */
export function mcpBackend(env: Env): McpBackend {
  return {
    async search(query, label, limit) {
      const params = new URLSearchParams({ q: query, view: 'all', limit: String(limit) });
      if (label.trim()) params.set('label', labelSlug(label));
      const result = await storage<ListResult>(env, `/list?${params.toString()}`);
      if (!result.bookmarks.length) return `No bookmarks matched “${query}”.`;
      return [
        `${result.total} match${result.total === 1 ? '' : 'es'} for “${query}”:`,
        '',
        ...result.bookmarks.map((bookmark, index) => renderCard(bookmark, index + 1)),
      ].join('\n');
    },

    async get(id) {
      const result = await storage<GetResult>(env, `/get?id=${encodeURIComponent(id)}`);
      return renderBookmark(result.bookmark);
    },

    async listTopics() {
      const data = await storage<TopicListResult>(env, '/topics');
      if (!data.topics.length) return 'No topics yet.';
      return data.topics
        .map((topic) => {
          const counts = `${topic.count} active${topic.archivedCount ? `, ${topic.archivedCount} archived` : ''}`;
          const parts = [`## ${topic.name} (\`${topic.slug}\`) — ${counts}`];
          if (topic.description) parts.push('', topic.description);
          if (topic.overview) parts.push('', topic.overview.trim());
          return parts.join('\n');
        })
        .join('\n\n');
    },

    async getTopic(slug, limit) {
      const topics = await storage<TopicListResult>(env, '/topics');
      const topic = topics.topics.find(
        (item) => item.slug === slug || item.name.toLowerCase() === slug.toLowerCase(),
      );
      if (!topic) {
        return `Unknown topic “${slug}”. Known slugs: ${topics.topics.map((item) => item.slug).join(', ') || '(none)'}`;
      }
      const result = await storage<ListResult>(
        env,
        `/list?topic=${encodeURIComponent(topic.slug)}&view=all&limit=${limit}`,
      );
      const counts = `${topic.count} active${topic.archivedCount ? `, ${topic.archivedCount} archived` : ''}`;
      const parts = [`# ${topic.name} — ${counts}`];
      if (topic.description) parts.push('', topic.description);
      if (topic.overview) parts.push('', '## Synthesis', '', topic.overview.trim());
      parts.push('', ...result.bookmarks.map((bookmark, index) => renderCard(bookmark, index + 1)));
      return parts.join('\n');
    },

    async createPost(input) {
      const content = String(input.content || '');
      if (!content.trim()) throw new Error('`content` is required.');
      const agentInput =
        input.agent && typeof input.agent === 'object' && !Array.isArray(input.agent)
          ? (input.agent as Record<string, unknown>)
          : {};
      const note = normalizeNoteInput({
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
      const result = await storage<SaveResult>(env, '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note),
      });
      const bookmark = result.bookmark;
      return [
        `${result.created ? 'Saved' : 'Updated'} note #${bookmark?.ref ?? '?'} (${bookmark?.format ?? note.format})`,
        bookmark?.title ? `Title: ${bookmark.title}` : '',
        `Id: ${bookmark?.tweetId ?? ''}`,
      ]
        .filter(Boolean)
        .join('\n');
    },

    guide() {
      return AUTHORING_GUIDE;
    },
  };
}
