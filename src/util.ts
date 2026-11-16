import type { BookmarkSource, SourceFilter } from './types.ts';

/**
 * Host of a `url` column, between `://` and the first `/`, in SQL. Kept in sync
 * with `sourceOfUrl` so the UI label and the list query agree.
 */
const URL_HOST_SQL = `CASE
  WHEN instr(lower(url), '://') > 0 THEN lower(substr(
    lower(url),
    instr(lower(url), '://') + 3,
    coalesce(
      nullif(instr(substr(lower(url), instr(lower(url), '://') + 3), '/'), 0),
      length(substr(lower(url), instr(lower(url), '://') + 3)) + 1
    ) - 1
  ))
  ELSE ''
END`;

/** The platform a bookmark URL points at; unknown hosts are `other`. */
export function sourceOfUrl(value: unknown): BookmarkSource {
  if (!value) return 'other';
  let host = '';
  try {
    host = new URL(String(value)).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (
    host === 'x.com' ||
    host.endsWith('.x.com') ||
    host === 'twitter.com' ||
    host.endsWith('.twitter.com')
  ) {
    return 'x';
  }
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return 'youtube';
  }
  return 'other';
}

/**
 * When a deployment serves the same instance on more than one custom domain,
 * move the legacy hosts to the canonical one. Returns the absolute target, or
 * null when no redirect applies. Both hosts stay attached; this only redirects.
 */
export function canonicalRedirectUrl(
  url: URL,
  canonicalHost: unknown,
  legacyHosts: unknown,
): string | null {
  const canonical = String(canonicalHost || '').trim().toLowerCase();
  if (!canonical) return null;
  const current = url.hostname.toLowerCase();
  if (current === canonical) return null;
  const legacy = String(legacyHosts || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
  if (!legacy.includes(current)) return null;
  return `https://${canonical}${url.pathname}${url.search}`;
}

/** `source` query value → a filter; anything unknown falls back to `all`. */
export function parseSource(value: unknown): SourceFilter {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'x' || raw === 'linkedin' || raw === 'youtube' ? raw : 'all';
}

/**
 * Repeated `source` query values → one deduplicated filter set. Each value runs
 * through `parseSource`, so unknown values fall back to `all`; an `all` anywhere
 * opens the cut back to every platform, which is what one unknown value does
 * today. An empty list means no source filter.
 */
export function parseSourceList(values: Iterable<unknown>): Exclude<SourceFilter, 'all'>[] {
  const sources: Exclude<SourceFilter, 'all'>[] = [];
  for (const value of values) {
    const source = parseSource(value);
    if (source === 'all') return [];
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

/** SQL predicate matching any of `sources`; empty when the cut is open. */
export function sourceFiltersSql(sources: readonly Exclude<SourceFilter, 'all'>[]): string {
  const parts = [...new Set(sources)].map(source => sourceFilterSql(source));
  return parts.length ? `(${parts.join(' OR ')})` : '';
}

/**
 * `column IN (?, ?, …)` for repeated filter values, duplicates dropped; null
 * when no value is set, so the caller can skip that cut entirely.
 */
export function filterInSql(
  column: string,
  values: readonly string[],
): { sql: string; args: string[] } | null {
  const unique = [...new Set(values)];
  if (!unique.length) return null;
  return { sql: `${column} IN (${unique.map(() => '?').join(', ')})`, args: unique };
}

/** SQL predicate over a `url` column for one source, matching `sourceOfUrl`. */
export function sourceFilterSql(source: Exclude<SourceFilter, 'all'>): string {
  const host = URL_HOST_SQL;
  switch (source) {
    case 'x':
      return `(${host} = 'x.com' OR ${host} LIKE '%.x.com' OR ${host} = 'twitter.com' OR ${host} LIKE '%.twitter.com')`;
    case 'linkedin':
      return `(${host} = 'linkedin.com' OR ${host} LIKE '%.linkedin.com')`;
    case 'youtube':
      return `(${host} = 'youtu.be' OR ${host} = 'youtube.com' OR ${host} LIKE '%.youtube.com')`;
  }
}

/**
 * Rows the topic-filing pass may pick. A saved post is filed only once its
 * summary is done, because the classifier reads it. A note is content on
 * arrival, so it files from its own extracted text and never waits for an AI
 * summary. While AI is unconfigured no filing can succeed, so only summarized
 * posts are selected and notes stay pending for a configured deployment.
 */
export function filingReadySql(aiConfigured: boolean): string {
  return aiConfigured
    ? `(summary_status = 'done' OR COALESCE(kind, 'post') = 'note')`
    : `summary_status = 'done'`;
}

/**
 * Re-queue `disabled` summaries once AI is configured. `disabled` means "saved
 * while AI was off", not a queue state, so no queue query selects it again and
 * those rows would stay stuck forever. An agent note that arrived without an
 * abstract is also `disabled`, but it is complete as written and must never be
 * summarized, so it stays out of this backlog. The batch is bounded because
 * the alarm summarizes one row per pass; a large backlog drains over several
 * passes instead of stalling the queue. Returns null while AI stays
 * unconfigured.
 */
export function recoverDisabledSummariesSql(aiConfigured: boolean): string | null {
  if (!aiConfigured) return null;
  return `UPDATE bookmarks
    SET summary_status = 'pending', summary_error = NULL, summary_started_at = NULL,
        summary_attempts = 0, summary_retry_at = NULL
    WHERE tweet_id IN (
      SELECT tweet_id FROM bookmarks
      WHERE summary_status = 'disabled'
        AND COALESCE(kind, 'post') != 'note'
      ORDER BY saved_at ASC
      LIMIT 10
    )`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeHttpUrl(value: unknown): string | null {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function linkifyText(text: unknown): string {
  const input = String(text ?? '');
  const urlPattern = /https?:\/\/[^\s]+/g;
  let output = '';
  let cursor = 0;

  for (const match of input.matchAll(urlPattern)) {
    output += textChunk(input.slice(cursor, match.index));
    const raw = match[0];
    const trailing = raw.match(/[),.;:!?]+$/)?.[0] ?? '';
    const href = trailing ? raw.slice(0, -trailing.length) : raw;
    const safeHref = safeHttpUrl(href);

    if (safeHref) {
      output += `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(href)}</a>`;
    } else {
      output += escapeHtml(href);
    }
    output += escapeHtml(trailing);
    cursor = match.index + raw.length;
  }

  output += textChunk(input.slice(cursor));
  return output;
}

function textChunk(value: string): string {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

export function truncate(value: unknown, maxLength: number): string {
  const input = String(value ?? '').trim();
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(value: unknown): string {
  if (!value) return '';
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormatter.format(date);
}

const compactFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatCount(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return compactFormatter.format(value);
}

export function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function htmlResponse(
  html: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: location } });
}

export function parseCookies(request: Request): Map<string, string> {
  const header = request.headers.get('Cookie') || '';
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

export async function sha256Hex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const ASCII_FOLD: Record<string, string> = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o',
  ş: 's', Ş: 's', ü: 'u', Ü: 'u', â: 'a', î: 'i', û: 'u',
};

export function slugify(value: unknown): string {
  const folded = String(value || '')
    .split('')
    .map(char => ASCII_FOLD[char] ?? char)
    .join('')
    .toLowerCase();
  const slug = folded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'topic';
}

/** Structural check for fetch/AbortController aborts without relying on DOMException identity. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
