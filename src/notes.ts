import { htmlToText } from './links.ts';
import { markdownToText } from './markdown.ts';
import { parseLabelNames } from './labels.ts';
import type { NoteAgent, NoteFormat, NoteInput } from './types.ts';
import { safeHttpUrl, sha256Hex } from './util.ts';

/** Server-side caps for agent notes; the CLI repeats them in `shelf add --help`. */
export const NOTE_LIMITS = {
  markdown: 256 * 1024,
  html: 1024 * 1024,
  title: 200,
  summary: 4_000,
  agentField: 120,
  clientId: 200,
  sourceUrl: 2_048,
} as const;

/** Plain text stored in `text` for search, summaries and export. */
export const NOTE_TEXT_LIMIT = 25_000;

/** Same shape the `/p/:ref` route accepts. */
export const NOTE_REF_PATTERN = /^[A-Za-z0-9_-]{1,30}$/;

/** A rejected note; the worker turns this into a 400 (or 404) with the message. */
export class NoteInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'NoteInputError';
    this.status = status;
  }
}

const DANGEROUS_ELEMENTS =
  /<\s*(script|iframe|object|embed|applet|template|frameset|frame|noscript)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DANGEROUS_TAGS =
  /<\s*\/?\s*(form|input|button|select|optgroup|option|textarea|base|link|meta)\b[^>]*>/gi;
const EVENT_ATTRIBUTE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DANGEROUS_ATTRIBUTE = /\s+(?:srcdoc|ping)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SCRIPT_PROTOCOL_ATTRIBUTE =
  /\s+(?:href|src|xlink:href|action|formaction|poster)\s*=\s*(?:"[^"]*(?:javascript|vbscript|data:text\/html)[^"]*"|'[^']*(?:javascript|vbscript|data:text\/html)[^']*'|(?:javascript|vbscript|data:text\/html)[^\s>]*)/gi;

/**
 * Best-effort sanitation for an untrusted HTML note. The sandboxed iframe and
 * its CSP are the real boundary; this keeps obviously dangerous markup out of
 * the stored row and out of the frame document.
 */
export function sanitizeNoteHtml(html: string): string {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DANGEROUS_ELEMENTS, '')
    .replace(DANGEROUS_TAGS, '')
    .replace(EVENT_ATTRIBUTE, '')
    .replace(DANGEROUS_ATTRIBUTE, '')
    .replace(SCRIPT_PROTOCOL_ATTRIBUTE, '');
}

export function parseNoteFormat(value: unknown): NoteFormat | null {
  return value === 'markdown' || value === 'html' ? value : null;
}

function stringField(value: unknown, max: number, label: string): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length > max) {
    throw new NoteInputError(`${label} is limited to ${max.toLocaleString('en-US')} characters.`);
  }
  return text;
}

function optionalString(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = stringField(value, max, label).trim();
  return text || null;
}

/**
 * The program that moved the note is not the thing that wrote it. Older
 * clients defaulted `agent.name` to "Shelf CLI" or "Shelf MCP"; storing that
 * credits the transport, so it is dropped and the note reads as unattributed
 * instead.
 */
const TRANSPORT_NAMES = new Set(['shelf cli', 'shelf-cli', 'shelf mcp', 'shelf-mcp']);

/** The name a note may credit; a transport's own name is not an author. */
export function noteAgentName(name: string | null | undefined): string {
  const text = String(name ?? '').trim();
  return TRANSPORT_NAMES.has(text.toLowerCase()) ? '' : text;
}

function parseAgent(value: unknown): NoteAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = noteAgentName(optionalString(record.name, NOTE_LIMITS.agentField, 'agent.name'));
  const model = optionalString(record.model, NOTE_LIMITS.agentField, 'agent.model');
  const tool = optionalString(record.tool, NOTE_LIMITS.agentField, 'agent.tool');
  if (!name && !model && !tool) return null;
  return { name, model: model || '', tool: tool || '' };
}

/** Validation for `POST /api/posts` and `shelf add`; throws `NoteInputError`. */
export function normalizeNoteInput(raw: unknown): NoteInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NoteInputError('Body must be a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  const format = parseNoteFormat(record.format);
  if (!format) {
    throw new NoteInputError('format must be "markdown" or "html".');
  }

  const rawContent = typeof record.content === 'string' ? record.content : '';
  if (!rawContent.trim()) {
    throw new NoteInputError('content is required.');
  }
  const bytes = new TextEncoder().encode(rawContent).length;
  const limit = NOTE_LIMITS[format];
  if (bytes > limit) {
    throw new NoteInputError(
      `${format} content is limited to ${Math.round(limit / 1024)} KB (got ${Math.round(bytes / 1024)} KB).`,
    );
  }
  const content = format === 'html' ? sanitizeNoteHtml(rawContent) : rawContent;

  const summary = optionalString(record.summary, NOTE_LIMITS.summary, 'summary');
  const sourceUrlRaw = optionalString(record.sourceUrl, NOTE_LIMITS.sourceUrl, 'sourceUrl');
  const sourceUrl = sourceUrlRaw ? safeHttpUrl(sourceUrlRaw) : null;
  if (sourceUrlRaw && !sourceUrl) {
    throw new NoteInputError('sourceUrl must be an http(s) URL.');
  }

  const clientId = optionalString(record.clientId, NOTE_LIMITS.clientId, 'clientId');
  const ref = optionalString(record.ref, 30, 'ref');
  if (ref && !NOTE_REF_PATTERN.test(ref)) {
    throw new NoteInputError('ref must be 1-30 letters, digits, dashes or underscores.');
  }

  return {
    format,
    content,
    title: noteTitle(record.title, format, content),
    summary,
    sourceUrl,
    clientId,
    ref,
    agent: parseAgent(record.agent),
    labels:
      record.labels === undefined || record.labels === null
        ? null
        : parseLabelNames(record.labels),
  };
}

/** An explicit title, else the first heading/line, else "Untitled note". */
export function noteTitle(value: unknown, format: NoteFormat, content: string): string {
  const given = optionalString(value, NOTE_LIMITS.title, 'title');
  if (given) return given;

  let candidate = '';
  if (format === 'markdown') {
    candidate =
      /^\s{0,3}#{1,3}\s+(.+)$/m.exec(content)?.[1] ??
      content
        .split('\n')
        .map(line => line.replace(/^\s{0,3}[-*+>]\s+/, '').trim())
        .find(Boolean) ??
      '';
    candidate = candidate.replace(/[*_`[\]]/g, '').trim();
  } else {
    candidate =
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)?.[1] ??
      /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content)?.[1] ??
      '';
    candidate = candidate.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return (candidate.slice(0, NOTE_LIMITS.title) || 'Untitled note').trim();
}

/** Extracted plain text for the `text` column; never raw HTML or markdown. */
export function notePlainText(format: NoteFormat, content: string): string {
  const text = format === 'html' ? htmlToText(content) : markdownToText(content);
  return text.replace(/\n{3,}/g, '\n\n').trim().slice(0, NOTE_TEXT_LIMIT);
}

/** `clientId` makes a retry update the same row; no id means a fresh note. */
export async function noteIdFor(clientId: string | null | undefined): Promise<string> {
  const key = String(clientId ?? '').trim();
  if (key) return `note-${(await sha256Hex(key)).slice(0, 16)}`;
  return `note-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
